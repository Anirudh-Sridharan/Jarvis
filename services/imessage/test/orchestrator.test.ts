/**
 * TXT-04 integration proof — the phase's headline "sustained multi-turn
 * self-chat" test (ROADMAP SC1): a sustained self-chat simulation where
 * every reply Jarvis sends is echoed back as a new inbound row (self-chat
 * means chat.db's is_from_me=1 on BOTH sides, so is_from_me alone cannot
 * discriminate — the fingerprint cross-check is the load-bearing guard
 * proven here), plus a reply-rate burst that trips the latching circuit
 * breaker and only resumes via an explicit reset().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageOrchestrator } from "../src/orchestrator.js";
import type { OrchestratorConfig } from "../src/orchestrator.js";
import { ImessageStateStore } from "../src/store/state.js";
import {
  FixedClock,
  FakeMessageSource,
  FakeMessageSender,
  FakeChatHandler,
} from "../src/testing/fakes.js";
import type { IncomingMessage } from "../src/types.js";

const OWNER = "owner@example.com";
const CHAT = "chat-self";

describe("MessageOrchestrator — sustained self-chat + burst breaker (TXT-04 / ROADMAP SC1)", () => {
  let tmpDir: string;
  let nextRowId: number;

  beforeEach(() => {
    nextRowId = 1;
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      guid: "guid-1",
      chatGuid: CHAT,
      senderId: OWNER,
      text: "hello",
      rowId: nextRowId++,
      timestampMs: 0,
      isFromMe: false,
      isGroupChat: false,
      ...overrides,
    };
  }

  function setup(
    configOverrides: OrchestratorConfig = {},
    opts: { autoEcho?: boolean } = {},
  ) {
    const autoEcho = opts.autoEcho ?? true;
    tmpDir = mkdtempSync(join(tmpdir(), "imsg-orch-int-"));
    const clock = new FixedClock(0);
    const source = new FakeMessageSource();
    const sender = new FakeMessageSender();
    const chatHandler = new FakeChatHandler();
    const store = new ImessageStateStore(tmpDir, clock);
    const echoGuids: string[] = [];

    if (autoEcho) {
      // Exactly what a self-chat thread echoes: every sent reply comes back
      // as a NEW inbound row with isFromMe=true and senderId = the owner's
      // own handle (self-chat: is_from_me=1 on BOTH sides).
      sender.onSend = (chatId, text) => {
        const guid = `echo-${nextRowId}`;
        echoGuids.push(guid);
        source.enqueue({
          guid,
          chatGuid: chatId,
          senderId: OWNER,
          text,
          rowId: nextRowId++,
          timestampMs: clock.now(),
          isFromMe: true,
          isGroupChat: false,
        });
      };
    }

    const orchestrator = new MessageOrchestrator(
      { source, sender, store, chatHandler, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT], ...configOverrides },
    );
    return { orchestrator, source, sender, chatHandler, store, clock, echoGuids };
  }

  describe("sustained multi-turn self-chat test", () => {
    it("every reply Jarvis sends is echoed back and never re-processed across a sustained multi-turn self-chat", async () => {
      const { orchestrator, source, chatHandler, store, echoGuids } = setup();
      chatHandler.replyFn = (call) => `ack: ${call.message}`;

      const userTexts = [
        "what's the weather",
        "remind me to call mom",
        "add eggs to the list",
        "what time is my meeting",
        "thanks",
      ];

      for (const text of userTexts) {
        source.enqueue(makeMessage({ guid: `u-${text}`, text }));
        // Tick 1: processes the user message, sends a reply, and (via the
        // onSend hook) enqueues that reply back into the source as an echo.
        await orchestrator.tick();
        // Tick 2: re-polls and must see the echo row and skip it.
        const echoResult = await orchestrator.tick();
        expect(echoResult.skipped.echo).toBeGreaterThanOrEqual(1);
        expect(echoResult.handled).toBe(0);
        expect(echoResult.sent).toBe(0);
      }

      // chatHandler.calls must contain ONLY the user-authored texts, never
      // a sent reply's text ("ack: ...").
      expect(chatHandler.calls.map((c) => c.message)).toEqual(userTexts);
      expect(chatHandler.calls.some((c) => c.message.startsWith("ack:"))).toBe(false);

      // Every echo GUID was marked processed — never re-examined on a later tick.
      expect(echoGuids.length).toBeGreaterThanOrEqual(userTexts.length);
      for (const guid of echoGuids) {
        expect(store.hasProcessed(guid)).toBe(true);
      }

      // One more tick: nothing left to poll, nothing left to handle.
      const finalResult = await orchestrator.tick();
      expect(finalResult.polled).toBe(0);
      expect(finalResult.handled).toBe(0);
    });

    it("an echoed reply with altered casing/punctuation is still caught as echo (normalization proven at integration level)", async () => {
      const { orchestrator, source, chatHandler, store } = setup({}, { autoEcho: false });
      chatHandler.reply = "Buy milk, please!";

      source.enqueue(makeMessage({ guid: "u1", text: "remind me" }));
      const sendResult = await orchestrator.tick();
      expect(sendResult.sent).toBe(1);
      expect(chatHandler.calls).toHaveLength(1);

      // Manually enqueue a casing/punctuation variant of the sent reply —
      // normalizeMessageText collapses both to the same "buy milk please".
      source.enqueue({
        guid: "echo-variant",
        chatGuid: CHAT,
        senderId: OWNER,
        text: "buy MILK please",
        rowId: nextRowId++,
        timestampMs: 0,
        isFromMe: true,
        isGroupChat: false,
      });

      const echoResult = await orchestrator.tick();
      expect(echoResult.skipped.echo).toBe(1);
      expect(echoResult.handled).toBe(0);
      expect(store.hasProcessed("echo-variant")).toBe(true);
      // Still only the original user message was ever handled.
      expect(chatHandler.calls).toHaveLength(1);
    });
  });

  describe("burst trip + latch + reset (ROADMAP SC1)", () => {
    it("a burst of distinct replies trips the latching breaker; further ticks are no-ops until an explicit reset resumes the held backlog", async () => {
      const { orchestrator, source, sender, chatHandler, store, clock } = setup(
        { breakerMaxReplies: 3, breakerWindowMs: 60_000 },
        { autoEcho: false },
      );

      // One distinct (non-echo) message per tick, so each tick produces
      // exactly one send — isolates recordReply's count to +1 per tick.
      // On a FixedClock that does NOT advance, so nothing prunes out of window.
      const preTripGuids = ["u0", "u1", "u2", "u3"];
      for (const guid of preTripGuids) {
        source.enqueue(makeMessage({ guid, text: `msg ${guid}` }));
        await orchestrator.tick();
      }

      // 4th reply exceeds maxReplies=3 within the window → latches open.
      expect(orchestrator.breaker.isOpen()).toBe(true);
      expect(sender.sends).toHaveLength(4);
      expect(chatHandler.calls).toHaveLength(4);
      const watermarkAtTrip = store.getWatermark();

      // Enqueue more messages while the breaker is open — they must be held,
      // not dropped.
      source.enqueue(makeMessage({ guid: "u-held-1", text: "held 1" }));
      source.enqueue(makeMessage({ guid: "u-held-2", text: "held 2" }));

      const resultAfterTrip1 = await orchestrator.tick();
      expect(resultAfterTrip1.breakerOpen).toBe(true);
      expect(resultAfterTrip1.handled).toBe(0);
      expect(resultAfterTrip1.sent).toBe(0);
      expect(store.getWatermark()).toBe(watermarkAtTrip);

      const resultAfterTrip2 = await orchestrator.tick();
      expect(resultAfterTrip2.breakerOpen).toBe(true);
      expect(resultAfterTrip2.handled).toBe(0);
      expect(store.getWatermark()).toBe(watermarkAtTrip);

      // Clock advancing far past the window does NOT auto-close (latch, not
      // a sliding window).
      clock.advance(60_000 * 10);
      const resultAfterAdvance = await orchestrator.tick();
      expect(resultAfterAdvance.breakerOpen).toBe(true);
      expect(orchestrator.breaker.isOpen()).toBe(true);
      expect(chatHandler.calls).toHaveLength(4); // unchanged while open

      // Explicit reset() resumes processing — the held backlog was never dropped.
      orchestrator.breaker.reset();
      const resultAfterReset = await orchestrator.tick();
      expect(resultAfterReset.breakerOpen).toBe(false);
      expect(resultAfterReset.handled).toBe(1); // held-1 + held-2 coalesce (same chat, same tick)
      expect(resultAfterReset.sent).toBe(1);

      // Every backlog GUID (pre-trip + held) was handled exactly once across
      // the whole run: 4 individual ticks + 1 coalesced post-reset tick = 5
      // total handle() calls, and every GUID is marked processed.
      expect(chatHandler.calls).toHaveLength(5);
      for (const guid of [...preTripGuids, "u-held-1", "u-held-2"]) {
        expect(store.hasProcessed(guid)).toBe(true);
      }

      // Nothing left to (re)process.
      const finalResult = await orchestrator.tick();
      expect(finalResult.polled).toBe(0);
      expect(finalResult.handled).toBe(0);
    });
  });
});
