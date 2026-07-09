/**
 * TXT-07 restart / watermark exactly-once proofs (ROADMAP SC4).
 *
 * Two orchestrator instances, one on-disk store (RESEARCH.md Pattern 4):
 * orchestrator A processes a backlog and is discarded (simulated
 * crash/restart); orchestrator B is constructed with a FRESH
 * ImessageStateStore on the SAME dataDir. Combined across A+B, every GUID
 * must be handled exactly once -- no duplicates, no drops -- including
 * recovery from a crash mid-batch (a sender failure after
 * chatHandler.handle() already succeeded and the GUID was already marked
 * processed: memory capture stays exactly-once; its reply is documented as
 * lost -- at-most-once delivery).
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
const CHAT_A = "chat-A";

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    guid: "guid-1",
    chatGuid: CHAT_A,
    senderId: OWNER,
    text: "hello",
    rowId: 1,
    timestampMs: 0,
    isFromMe: false,
    isGroupChat: false,
    ...overrides,
  };
}

describe("MessageOrchestrator — restart / watermark exactly-once (TXT-07 / ROADMAP SC4)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a clean restart processes only the new backlog: combined across A+B, every guid handled exactly once, no drops", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "imsg-watermark-"));
    const clock = new FixedClock(0);

    // Orchestrator A: processes rows 1-3, watermark ends at 3, then A is
    // discarded (simulated crash/restart boundary).
    const sourceA = new FakeMessageSource();
    const senderA = new FakeMessageSender();
    const chatHandlerA = new FakeChatHandler();
    const storeA = new ImessageStateStore(tmpDir, clock);
    const orchestratorA = new MessageOrchestrator(
      { source: sourceA, sender: senderA, store: storeA, chatHandler: chatHandlerA, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT_A] },
    );
    sourceA.enqueue(makeMessage({ guid: "g1", rowId: 1, text: "one" }));
    sourceA.enqueue(makeMessage({ guid: "g2", rowId: 2, text: "two" }));
    sourceA.enqueue(makeMessage({ guid: "g3", rowId: 3, text: "three" }));

    const resultA = await orchestratorA.tick();
    expect(resultA.handled).toBe(1); // coalesced: same chat, one tick
    expect(chatHandlerA.calls).toHaveLength(1);
    expect(storeA.getWatermark()).toBe(3);
    storeA.close();

    // Orchestrator B: FRESH store on the SAME dataDir (simulated restart),
    // source now holds rows 1-6 (as if chat.db kept accumulating).
    const sourceB = new FakeMessageSource();
    const senderB = new FakeMessageSender();
    const chatHandlerB = new FakeChatHandler();
    const storeB = new ImessageStateStore(tmpDir, clock);
    const orchestratorB = new MessageOrchestrator(
      { source: sourceB, sender: senderB, store: storeB, chatHandler: chatHandlerB, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT_A] },
    );
    sourceB.enqueue(makeMessage({ guid: "g1", rowId: 1, text: "one" }));
    sourceB.enqueue(makeMessage({ guid: "g2", rowId: 2, text: "two" }));
    sourceB.enqueue(makeMessage({ guid: "g3", rowId: 3, text: "three" }));
    sourceB.enqueue(makeMessage({ guid: "g4", rowId: 4, text: "four" }));
    sourceB.enqueue(makeMessage({ guid: "g5", rowId: 5, text: "five" }));
    sourceB.enqueue(makeMessage({ guid: "g6", rowId: 6, text: "six" }));

    const resultB = await orchestratorB.tick();
    // B's watermark starts at 3 (persisted) -> pollSince(3) returns only rows 4-6.
    expect(resultB.polled).toBe(3);
    expect(resultB.handled).toBe(1); // coalesced: rows 4-6, same chat
    expect(chatHandlerB.calls).toHaveLength(1);
    expect(chatHandlerB.calls[0]!.message).toBe("four\nfive\nsix");
    expect(storeB.getWatermark()).toBe(6);

    // Combined across A+B: every guid handled exactly once (no drops).
    const combinedText = [...chatHandlerA.calls, ...chatHandlerB.calls]
      .map((c) => c.message)
      .join("\n");
    for (const text of ["one", "two", "three", "four", "five", "six"]) {
      expect(combinedText.split("\n").filter((t) => t === text)).toHaveLength(1);
    }
    storeB.close();
  });

  it("crash mid-batch: a send failure after handle() succeeded stops the tick; restart re-polls without re-handling the already-processed guid, and no later message is lost", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "imsg-watermark-crash-"));
    const clock = new FixedClock(0);

    const CHAT_1 = "chat-1";
    const CHAT_2 = "chat-2";
    const CHAT_3 = "chat-3";

    // Orchestrator A: three messages in three DIFFERENT chats (no
    // coalescing). sender.errorOnNthSend = 2 fails chat 2's send.
    const sourceA = new FakeMessageSource();
    const senderA = new FakeMessageSender();
    senderA.errorOnNthSend = 2;
    const chatHandlerA = new FakeChatHandler();
    const storeA = new ImessageStateStore(tmpDir, clock);
    const orchestratorA = new MessageOrchestrator(
      { source: sourceA, sender: senderA, store: storeA, chatHandler: chatHandlerA, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT_1, CHAT_2, CHAT_3] },
    );
    sourceA.enqueue(makeMessage({ guid: "g1", chatGuid: CHAT_1, rowId: 1, text: "one" }));
    sourceA.enqueue(makeMessage({ guid: "g2", chatGuid: CHAT_2, rowId: 2, text: "two" }));
    sourceA.enqueue(makeMessage({ guid: "g3", chatGuid: CHAT_3, rowId: 3, text: "three" }));

    const resultA = await orchestratorA.tick();

    // Chat 1 fully handled + sent; chat 2's handle() also ran (both succeed
    // before any send happens) but its send failed.
    expect(chatHandlerA.calls).toHaveLength(2);
    expect(senderA.sends).toHaveLength(1); // only chat 1's send succeeded
    expect(resultA.errors.length).toBeGreaterThan(0);

    // Chat 2's guid IS marked processed even though its send failed
    // (exactly-once memory capture; at-most-once reply delivery).
    expect(storeA.hasProcessed("g2")).toBe(true);
    // Chat 3 was never reached at all (tick stopped at chat 2's failure).
    expect(storeA.hasProcessed("g3")).toBe(false);

    // Watermark reflects only chat 1's fully-handled rowId.
    expect(storeA.getWatermark()).toBe(1);
    storeA.close();

    // Restart: fresh store, same dataDir.
    const sourceB = new FakeMessageSource();
    const senderB = new FakeMessageSender();
    const chatHandlerB = new FakeChatHandler();
    const storeB = new ImessageStateStore(tmpDir, clock);
    const orchestratorB = new MessageOrchestrator(
      { source: sourceB, sender: senderB, store: storeB, chatHandler: chatHandlerB, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT_1, CHAT_2, CHAT_3] },
    );
    // chat.db still holds rows 2 and 3 (row 1 is before the persisted watermark).
    sourceB.enqueue(makeMessage({ guid: "g2", chatGuid: CHAT_2, rowId: 2, text: "two" }));
    sourceB.enqueue(makeMessage({ guid: "g3", chatGuid: CHAT_3, rowId: 3, text: "three" }));

    const resultB = await orchestratorB.tick();

    // Row 2's guid is skipped alreadyProcessed (its reply is lost --
    // documented at-most-once delivery -- but memory capture is never
    // duplicated).
    expect(resultB.skipped.alreadyProcessed).toBe(1);
    // Row 3 is NOT lost: handled normally after restart.
    expect(chatHandlerB.calls).toHaveLength(1);
    expect(chatHandlerB.calls[0]!.externalMessageId).toBe("g3");
    expect(senderB.sends).toHaveLength(1);
    expect(storeB.getWatermark()).toBe(3);

    // Total handle() calls across A+B: exactly 3 (one per guid: g1, g2, g3).
    expect(chatHandlerA.calls.length + chatHandlerB.calls.length).toBe(3);
    storeB.close();
  });
});
