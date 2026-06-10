/**
 * Tests for capture: dedup, conversation+note capture, embed state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { CaptureService } from "../src/capture/capture.js";
import { FakeEmbedder } from "../src/testing/fakes.js";
import { computeDedupKey } from "../src/capture/experience.js";

function makeCapture() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-capture-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const capture = new CaptureService(store, embedder);
  return { capture, store };
}

describe("Capture - dedup", () => {
  it("drops exact duplicate records", async () => {
    const { capture } = makeCapture();
    const r1 = await capture.captureNote({ text: "Hello world", noteId: "n1" });
    const r2 = await capture.captureNote({ text: "Hello world", noteId: "n1" });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
  });

  it("inserts different records with different noteIds", async () => {
    const { capture } = makeCapture();
    const r1 = await capture.captureNote({ text: "Note A", noteId: "na1" });
    const r2 = await capture.captureNote({ text: "Note B", noteId: "nb1" });
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
    expect(r1.record.id).not.toBe(r2.record.id);
  });

  it("different content with same noteId is different dedup_key", async () => {
    const { capture } = makeCapture();
    const r1 = await capture.captureNote({ text: "Version 1", noteId: "n100" });
    const r2 = await capture.captureNote({ text: "Version 2", noteId: "n100" });
    // Different content hash → different dedup_key → both inserted
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(true);
  });
});

describe("Capture - conversation turn", () => {
  it("captures a user turn", async () => {
    const { capture } = makeCapture();
    const result = await capture.captureConversationTurn({
      role: "user",
      content: "What is TypeScript?",
      conversationId: "conv-1",
      messageId: "msg-u1",
    });
    expect(result.inserted).toBe(true);
    expect(result.record.source).toBe("conversation");
    expect(result.record.type).toBe("message");
    expect(result.record.actor).toBe("user");
  });

  it("captures an assistant turn", async () => {
    const { capture } = makeCapture();
    const result = await capture.captureConversationTurn({
      role: "assistant",
      content: "TypeScript is a typed superset of JavaScript.",
      conversationId: "conv-1",
      messageId: "msg-a1",
    });
    expect(result.inserted).toBe(true);
    expect(result.record.actor).toBe("assistant");
  });

  it("deduplicates the same message captured twice", async () => {
    const { capture } = makeCapture();
    const opts = {
      role: "user" as const,
      content: "Same message",
      conversationId: "conv-dup",
      messageId: "msg-dup1",
    };
    await capture.captureConversationTurn(opts);
    const r2 = await capture.captureConversationTurn(opts);
    expect(r2.inserted).toBe(false);
  });
});

describe("Capture - note", () => {
  it("captures a note with tags as entities", async () => {
    const { capture } = makeCapture();
    const result = await capture.captureNote({
      text: "Remember to review the PR",
      noteId: "note-pr-1",
      tags: ["work", "code-review"],
    });
    expect(result.inserted).toBe(true);
    expect(result.record.entities).toHaveLength(2);
    expect(result.record.entities[0]?.kind).toBe("tag");
    expect(result.record.entities[0]?.value).toBe("work");
  });
});

describe("Capture - embed state", () => {
  it("short text gets embed_state=done (embedded immediately)", async () => {
    const { capture, store } = makeCapture();
    await capture.captureNote({ text: "Short note", noteId: "short-1" });
    // Check the store's experience record — embed_state should be 'done'
    const pending = store.getPendingExperienceRecords();
    // Note: embed_state is updated in DB; pending still means consolidation_pending=1
    // Since we embed immediately, embed_state = 'done'
    expect(pending[0]?.embed_state).toBe("done");
  });

  it("long text gets embed_state=deferred", async () => {
    const { capture, store } = makeCapture();
    const longText = "a".repeat(3000); // > 2048 chars threshold
    await capture.captureNote({ text: longText, noteId: "long-1" });
    const pending = store.getPendingExperienceRecords();
    expect(pending[0]?.embed_state).toBe("deferred");
  });
});

describe("computeDedupKey", () => {
  it("produces stable, deterministic keys", () => {
    const k1 = computeDedupKey("note", "n1", { text: "hello" });
    const k2 = computeDedupKey("note", "n1", { text: "hello" });
    expect(k1).toBe(k2);
  });

  it("different source produces different key", () => {
    const k1 = computeDedupKey("note", "n1", "content");
    const k2 = computeDedupKey("gmail", "n1", "content");
    expect(k1).not.toBe(k2);
  });

  it("key format is source:nativeId:sha256:hash", () => {
    const k = computeDedupKey("conversation", "msg-1", "hello");
    expect(k).toMatch(/^conversation:msg-1:sha256:[a-f0-9]{64}$/);
  });
});
