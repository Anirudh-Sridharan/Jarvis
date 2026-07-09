/**
 * TXT-06 identity / ChatHandler contract-parity proofs (ROADMAP SC3).
 *
 * LOCKED documented behavior (09-RESEARCH.md Open Question Q1, Option A):
 * identity is GUID-keyed, exactly-once. Re-delivering an already-processed
 * GUID -- whether the content was edited or the message was unsent
 * (chat.db still emits a row for it) -- is intentionally NOT re-processed
 * this phase. This is a structural guarantee against duplicate memory
 * records, at the cost of not reflecting the user's edit/unsend intent
 * into an already-captured turn. No @jarvis/memory changes exist this
 * phase to reconcile that gap.
 *
 * TODO(phase-future): iMessage edit -> memory correction.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageOrchestrator } from "../src/orchestrator.js";
import { ImessageStateStore } from "../src/store/state.js";
import {
  FixedClock,
  FakeMessageSource,
  FakeMessageSender,
  FakeChatHandler,
} from "../src/testing/fakes.js";
import type { IncomingMessage } from "../src/types.js";

const OWNER = "owner@example.com";
const CHAT_A = "CHAT-A";

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    guid: "G-1",
    chatGuid: CHAT_A,
    senderId: OWNER,
    text: "remind me to buy milk",
    rowId: 1,
    timestampMs: 0,
    isFromMe: false,
    isGroupChat: false,
    ...overrides,
  };
}

describe("MessageOrchestrator — identity + ChatHandler contract parity (TXT-06 / ROADMAP SC3)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "imsg-identity-"));
    const clock = new FixedClock(0);
    const source = new FakeMessageSource();
    const sender = new FakeMessageSender();
    const chatHandler = new FakeChatHandler();
    const store = new ImessageStateStore(tmpDir, clock);
    const orchestrator = new MessageOrchestrator(
      { source, sender, store, chatHandler, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT_A] },
    );
    return { orchestrator, source, sender, chatHandler, store, clock };
  }

  it("processing a message yields the exact ChatCore.send()-compatible handle() tuple and a matching send()", async () => {
    const { orchestrator, source, sender, chatHandler } = setup();
    chatHandler.reply = "Got it, adding milk to your list.";
    source.enqueue(makeMessage({ guid: "G-1", text: "remind me to buy milk" }));

    const result = await orchestrator.tick();

    expect(result.handled).toBe(1);
    expect(chatHandler.calls[0]).toEqual({
      message: "remind me to buy milk",
      conversationId: "imessage:CHAT-A",
      externalMessageId: "G-1",
    });
    expect(sender.sends[0]).toEqual({
      chatId: "CHAT-A",
      text: "Got it, adding milk to your list.",
    });
  });

  it("simulated edit: re-delivering a processed GUID at a new rowId with different text is NOT re-processed, but the watermark advances past it", async () => {
    const { orchestrator, source, chatHandler, store } = setup();
    source.enqueue(makeMessage({ guid: "G-1", rowId: 1, text: "remind me to buy milk" }));
    await orchestrator.tick();
    expect(chatHandler.calls).toHaveLength(1);
    const watermarkAfterFirst = store.getWatermark();

    // Simulated edit: same GUID, new rowId (chat.db re-syncs the row), different text.
    source.enqueue(makeMessage({ guid: "G-1", rowId: 2, text: "remind me to buy oat milk" }));
    const editResult = await orchestrator.tick();

    expect(editResult.skipped.alreadyProcessed).toBe(1);
    expect(editResult.handled).toBe(0);
    expect(chatHandler.calls).toHaveLength(1); // unchanged — zero new handle/send calls
    expect(store.getWatermark()).toBeGreaterThan(watermarkAfterFirst);
    expect(store.getWatermark()).toBe(2);
  });

  it("simulated unsend: re-delivering a processed GUID with empty text is NOT re-processed", async () => {
    const { orchestrator, source, chatHandler, store } = setup();
    source.enqueue(makeMessage({ guid: "G-1", rowId: 1, text: "remind me to buy milk" }));
    await orchestrator.tick();
    expect(chatHandler.calls).toHaveLength(1);

    // Simulated unsend: chat.db still emits a row for the same GUID, now empty.
    source.enqueue(makeMessage({ guid: "G-1", rowId: 2, text: "" }));
    const unsendResult = await orchestrator.tick();

    expect(unsendResult.skipped.alreadyProcessed).toBe(1);
    expect(unsendResult.handled).toBe(0);
    expect(chatHandler.calls).toHaveLength(1); // unchanged — same non-re-processing behavior
    expect(store.getWatermark()).toBe(2);
  });
});
