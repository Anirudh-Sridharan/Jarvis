/**
 * Tests for MessageOrchestrator's tick() pipeline scoping rules (TXT-05):
 * owner-only + chat-allowlist + group-chat-ignore, fail-closed on empty
 * config, per-chat coalescing, and structural never-originate (tick() is
 * the only send path — an empty poll or a tick with only ignored messages
 * produces zero sends).
 */

import { describe, it, expect, afterEach } from "vitest";
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

describe("MessageOrchestrator — allowlist, scoping, never-originate (TXT-05)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(configOverrides: OrchestratorConfig = {}) {
    tmpDir = mkdtempSync(join(tmpdir(), "imsg-orch-"));
    const clock = new FixedClock(0);
    const source = new FakeMessageSource();
    const sender = new FakeMessageSender();
    const chatHandler = new FakeChatHandler();
    const store = new ImessageStateStore(tmpDir, clock);
    const orchestrator = new MessageOrchestrator(
      { source, sender, store, chatHandler, clock },
      { ownerHandles: [OWNER], allowedChatGuids: [CHAT_A], ...configOverrides },
    );
    return { orchestrator, source, sender, chatHandler, store, clock };
  }

  it("a fully-allowlisted message produces exactly one handle() call and one send() to its own chatGuid", async () => {
    const { orchestrator, source, sender, chatHandler } = setup();
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, text: "hi" }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(1);
    expect(chatHandler.calls[0]).toMatchObject({
      message: "hi",
      conversationId: "imessage:" + CHAT_A,
      externalMessageId: "g1",
    });
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]).toMatchObject({ chatId: CHAT_A });
    expect(result.handled).toBe(1);
    expect(result.sent).toBe(1);
  });

  it("ignores a message from a non-allowlisted senderId: zero handle/send, watermark advances past it", async () => {
    const { orchestrator, source, sender, chatHandler, store } = setup();
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, senderId: "stranger@example.com" }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(0);
    expect(sender.sends).toHaveLength(0);
    expect(result.skipped.notAllowlisted).toBe(1);
    expect(store.getWatermark()).toBe(1);
  });

  it("ignores a message in a non-allowlisted chatGuid: zero handle/send, watermark advances past it", async () => {
    const { orchestrator, source, sender, chatHandler, store } = setup();
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, chatGuid: "chat-other" }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(0);
    expect(sender.sends).toHaveLength(0);
    expect(result.skipped.notAllowlisted).toBe(1);
    expect(store.getWatermark()).toBe(1);
  });

  it("ignores a group-chat message unconditionally: zero handle/send, watermark advances past it", async () => {
    const { orchestrator, source, sender, chatHandler, store } = setup();
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, isGroupChat: true }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(0);
    expect(sender.sends).toHaveLength(0);
    expect(result.skipped.group).toBe(1);
    expect(store.getWatermark()).toBe(1);
  });

  it("fail closed: empty ownerHandles processes nothing regardless of content", async () => {
    const { orchestrator, source, sender, chatHandler } = setup({ ownerHandles: [] });
    source.enqueue(makeMessage({ guid: "g1", rowId: 1 }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(0);
    expect(sender.sends).toHaveLength(0);
    expect(result.skipped.notAllowlisted).toBe(1);
  });

  it("fail closed: empty allowedChatGuids processes nothing regardless of content", async () => {
    const { orchestrator, source, sender, chatHandler } = setup({ allowedChatGuids: [] });
    source.enqueue(makeMessage({ guid: "g1", rowId: 1 }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(0);
    expect(sender.sends).toHaveLength(0);
    expect(result.skipped.notAllowlisted).toBe(1);
  });

  it("never originates: an empty poll produces zero handle/send calls", async () => {
    const { orchestrator, sender, chatHandler } = setup();

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(0);
    expect(sender.sends).toHaveLength(0);
    expect(result.polled).toBe(0);
  });

  it("a tick processing only ignored messages produces zero sends", async () => {
    const { orchestrator, source, sender, chatHandler } = setup();
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, isGroupChat: true }));
    source.enqueue(makeMessage({ guid: "g2", rowId: 2, senderId: "stranger@example.com" }));

    const result = await orchestrator.tick();

    expect(sender.sends).toHaveLength(0);
    expect(chatHandler.calls).toHaveLength(0);
    expect(result.skipped.group).toBe(1);
    expect(result.skipped.notAllowlisted).toBe(1);
  });

  it("coalesces multiple pending messages in the same chat into ONE handle() call, joined by newline, keyed on the last guid", async () => {
    const { orchestrator, source, sender, chatHandler } = setup();
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, text: "buy milk" }));
    source.enqueue(makeMessage({ guid: "g2", rowId: 2, text: "and eggs" }));
    source.enqueue(makeMessage({ guid: "g3", rowId: 3, text: "please" }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(1);
    expect(chatHandler.calls[0]!.message).toBe("buy milk\nand eggs\nplease");
    expect(chatHandler.calls[0]!.externalMessageId).toBe("g3");
    expect(sender.sends).toHaveLength(1);
    expect(result.handled).toBe(1);
    expect(result.sent).toBe(1);
  });

  it("messages in different chats produce separate handle/send calls", async () => {
    const { orchestrator, source, sender, chatHandler } = setup({
      allowedChatGuids: [CHAT_A, "chat-B"],
    });
    source.enqueue(makeMessage({ guid: "g1", rowId: 1, chatGuid: CHAT_A, text: "hi A" }));
    source.enqueue(makeMessage({ guid: "g2", rowId: 2, chatGuid: "chat-B", text: "hi B" }));

    const result = await orchestrator.tick();

    expect(chatHandler.calls).toHaveLength(2);
    expect(sender.sends).toHaveLength(2);
    expect(result.handled).toBe(2);
    expect(result.sent).toBe(2);
  });
});
