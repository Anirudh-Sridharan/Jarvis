/**
 * SqliteConversationStore tests:
 *   - round-trip create/append/update
 *   - durability: a NEW store instance over the same DB sees everything
 *   - live-object contract: appends are visible through previously returned
 *     references (ChatCore depends on this)
 *   - title derivation, message ordering, getOrCreate fallback
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SqliteConversationStore } from "../src/chat/sqliteConversationStore.js";

function makeDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

describe("SqliteConversationStore", () => {
  let db: DatabaseSync;
  let store: SqliteConversationStore;

  beforeEach(() => {
    db = makeDb();
    store = new SqliteConversationStore(db);
  });

  it("creates, appends, and reads back a conversation", () => {
    const conv = store.create("local");
    store.append(conv.id, "user", "Hello Jarvis");
    store.append(conv.id, "assistant", "Hello back");

    const got = store.get(conv.id)!;
    expect(got.messages).toHaveLength(2);
    expect(got.messages[0]!.role).toBe("user");
    expect(got.messages[1]!.content).toBe("Hello back");
    expect(got.title).toBe("Hello Jarvis"); // derived from first user turn
  });

  it("survives a new store instance over the same DB (durability)", () => {
    const conv = store.create("local");
    store.append(conv.id, "user", "Remember me after restart");
    store.append(conv.id, "assistant", "I will");
    store.update(conv.id, { rollingSummary: "greeting exchange" });

    // Simulate a core restart: fresh store, same database
    const store2 = new SqliteConversationStore(db);
    const got = store2.get(conv.id)!;

    expect(got.title).toBe("Remember me after restart");
    expect(got.messages.map((m) => m.content)).toEqual([
      "Remember me after restart",
      "I will",
    ]);
    expect(got.rollingSummary).toBe("greeting exchange");
    expect(got.mode).toBe("local");
  });

  it("preserves the live-object contract ChatCore depends on", () => {
    const conv = store.getOrCreate(undefined, "local");
    // ChatCore appends THEN reads conv.messages through the old reference
    store.append(conv.id, "user", "turn one");
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages.slice(0, -1)).toHaveLength(0); // prior history

    store.append(conv.id, "assistant", "reply one");
    expect(conv.messages).toHaveLength(2);
    // get() returns the SAME live object, not a snapshot
    expect(store.get(conv.id)).toBe(conv);
  });

  it("orders messages by seq across hydration", () => {
    const conv = store.create("cloud");
    for (let i = 0; i < 5; i++) {
      store.append(conv.id, i % 2 === 0 ? "user" : "assistant", `msg ${i}`);
    }

    const store2 = new SqliteConversationStore(db);
    const got = store2.get(conv.id)!;
    expect(got.messages.map((m) => m.content)).toEqual([
      "msg 0",
      "msg 1",
      "msg 2",
      "msg 3",
      "msg 4",
    ]);
  });

  it("persists message extras (captureStatus, assembledPromptRef, tokenCount)", () => {
    const conv = store.create("local");
    store.append(conv.id, "user", "with extras", { captureStatus: "pending" });
    store.append(conv.id, "assistant", "ok", { assembledPromptRef: `${conv.id}:1` });

    const got = new SqliteConversationStore(db).get(conv.id)!;
    expect(got.messages[0]!.captureStatus).toBe("pending");
    expect(got.messages[0]!.tokenCount).toBeGreaterThan(0);
    expect(got.messages[1]!.assembledPromptRef).toBe(`${conv.id}:1`);
  });

  it("getOrCreate falls back to a new conversation for unknown ids", () => {
    const conv = store.getOrCreate("does-not-exist", "local");
    expect(conv.id).not.toBe("does-not-exist");
    expect(store.get(conv.id)).toBeDefined();
  });

  it("update persists mode and summary fields", () => {
    const conv = store.create("local");
    store.update(conv.id, {
      mode: "cloud",
      rollingSummary: "sum",
      summaryThroughMessageId: "m-9",
    });

    const got = new SqliteConversationStore(db).get(conv.id)!;
    expect(got.mode).toBe("cloud");
    expect(got.rollingSummary).toBe("sum");
    expect(got.summaryThroughMessageId).toBe("m-9");
  });

  it("throws on append/update for unknown conversations", () => {
    expect(() => store.append("nope", "user", "x")).toThrow("Conversation not found");
    expect(() => store.update("nope", { title: "x" })).toThrow("Conversation not found");
  });
});
