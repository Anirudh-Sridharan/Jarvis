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
import { ConsolidationService } from "../src/consolidation/consolidation.js";
import { RetrievalService } from "../src/retrieval/retrieval.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";
import { computeDedupKey } from "../src/capture/experience.js";

function makeCapture(llm: FakeLlm = new FakeLlm()) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-capture-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const capture = new CaptureService(store, embedder);
  const consolidation = new ConsolidationService(store, llm, embedder);
  const retrieval = new RetrievalService(store, embedder);
  return { capture, store, embedder, consolidation, retrieval, llm };
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

describe("Capture - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  // FakeLlm's default extraction result is a fixed "User prefers TypeScript"
  // fact, and consolidation never copies a captured record's own literal text
  // into the graph — the ONLY way a canary marker reaches the searchable
  // corpus is via llm.addOverride() keyed on a distinctive substring of the
  // captured body (see services/memory/src/testing/fakes.ts, extract.ts).

  it("Case A: a captured user chat turn is recallable by content after force-consolidation", async () => {
    const marker = "eval-canary-chat-4471";
    const { capture, store, consolidation, retrieval, llm } = makeCapture();
    // reflectInsights()'s prompt also embeds a raw sample of the same pending
    // record text (under "Recent experiences:"), so a marker override would
    // otherwise ALSO match the reflection call and mint a duplicate episode
    // via indexInsightAsEpisode(). Suppress reflection explicitly (checked
    // first, so it wins for that prompt only) to keep this a clean single-fact
    // proof. "Recent experiences:" appears only in the reflect prompt, never
    // in the extraction prompt.
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        {
          entity: "self",
          predicate: "mentions",
          object: marker,
          text: `User mentioned ${marker} during a chat turn`,
          confidence: 0.9,
        },
      ]),
    );

    await capture.captureConversationTurn({
      role: "user",
      content: `Just a heads up, ${marker} is the topic today`,
      conversationId: "conv-mem06-chat",
      messageId: "msg-mem06-chat-1",
    });
    expect(store.getPendingExperienceRecords().length).toBeGreaterThan(0);

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.errors).toHaveLength(0);
    expect(store.getPendingExperienceRecords()).toHaveLength(0);

    const results = await retrieval.retrieve(`${marker} chat turn`, { k: 5 });
    const hit = results.find((r) => r.text.includes(marker));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("fact");
  });

  it("Case B: a captured note is recallable by content after force-consolidation", async () => {
    const marker = "eval-canary-note-7734";
    const { capture, store, consolidation, retrieval, llm } = makeCapture();
    // Same reflect-prompt-crosstalk guard as Case A above.
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        {
          entity: "self",
          predicate: "noted",
          object: marker,
          text: `Note contains ${marker} for later reference`,
          confidence: 0.9,
        },
      ]),
    );

    await capture.captureNote({
      text: `Reminder: ${marker} needs follow-up`,
      noteId: "note-mem06-1",
    });
    expect(store.getPendingExperienceRecords().length).toBeGreaterThan(0);

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.errors).toHaveLength(0);

    const results = await retrieval.retrieve(`${marker} follow-up`, { k: 5 });
    const hit = results.find((r) => r.text.includes(marker));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("fact");
  });

  it("Case C: the anti-fake guard — consolidation genuinely ran rather than being faked", async () => {
    const marker = "eval-canary-guard-3391";
    const { capture, consolidation, llm } = makeCapture();
    // Same reflect-prompt-crosstalk guard as Case A above.
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        {
          entity: "self",
          predicate: "mentions",
          object: marker,
          text: `Guard check for ${marker}`,
          confidence: 0.9,
        },
      ]),
    );

    await capture.captureNote({
      text: `Anti-fake guard marker ${marker}`,
      noteId: "note-mem06-guard",
    });

    const result = await consolidation.run("manual");
    // The real 9-stage pipeline processed this record and minted a fact from
    // it — a direct row-level flag flip on the pending flag would never be
    // able to produce a genuine extracted-fact count like this.
    expect(result.run.counts.recordsProcessed).toBeGreaterThanOrEqual(1);
    expect(result.run.counts.factsExtracted).toBeGreaterThanOrEqual(1);
  });
});
