/**
 * Tests for the optional second-stage reranker in hybrid retrieval.
 *
 * Verifies: a reranker reorders the top candidates; an absent reranker leaves
 * retrieval unchanged (and deterministic); a failing or malformed reranker
 * degrades gracefully to first-stage order.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { RetrievalService } from "../src/retrieval/retrieval.js";
import { FakeEmbedder, FakeReranker } from "../src/testing/fakes.js";
import type { Reranker } from "../src/types.js";

/** Build a store + embedder, and seed three episodes. Returns their ids. */
async function makeSeeded() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-reranker-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);

  // A and C share tokens with the query; B (the "banana" doc) shares none, so
  // it ranks LOW in first-stage retrieval. recency/importance are left at their
  // defaults (equal across all three) so the reranker term is the sole tiebreak.
  const a = await store.upsertEpisode({
    text: "TypeScript programming language gives strong type safety to programming",
    occurredAt: "2026-06-01T10:00:00Z",
    provenance: { source: "chat", sourceId: "a", confidence: 0.9 },
  });
  const b = await store.upsertEpisode({
    text: "I ate a banana for breakfast this morning",
    occurredAt: "2026-06-01T10:00:00Z",
    provenance: { source: "note", sourceId: "b", confidence: 0.9 },
  });
  const c = await store.upsertEpisode({
    text: "Python is also a great programming language for scripting",
    occurredAt: "2026-06-01T10:00:00Z",
    provenance: { source: "chat", sourceId: "c", confidence: 0.9 },
  });

  return { store, embedder, ids: { a: a.id, b: b.id, c: c.id } };
}

const QUERY = "TypeScript programming language";

describe("RetrievalService - reranker reorders results", () => {
  it("promotes the candidate the reranker scores highest, even if it ranked low first-stage", async () => {
    const { store, embedder, ids } = await makeSeeded();

    // First-stage only (no reranker): the banana doc should NOT be on top.
    const base = new RetrievalService(store, embedder);
    const baseResults = await base.retrieve(QUERY, { k: 5, now: Date.parse("2026-06-02T10:00:00Z") });
    expect(baseResults[0]?.memoryId).not.toBe(ids.b);
    // First-stage results carry no reranker score.
    expect(baseResults.every((r) => r.scoreBreakdown.rerankerScore === undefined)).toBe(true);

    // Reranker that loves bananas → forces the banana doc to the top.
    const bananaLover = new FakeReranker((_q, doc) => (/banana/i.test(doc) ? 10 : 1));
    const reranked = new RetrievalService(store, embedder, undefined, bananaLover);
    const rrResults = await reranked.retrieve(QUERY, { k: 5, now: Date.parse("2026-06-02T10:00:00Z") });

    expect(rrResults[0]?.memoryId).toBe(ids.b);
    // The promoted result carries the (normalized, max) reranker score.
    expect(rrResults[0]?.scoreBreakdown.rerankerScore).toBe(1);
  });
});

describe("RetrievalService - absent reranker is unchanged + deterministic", () => {
  it("produces identical ordering across runs and never sets rerankerScore", async () => {
    const { store, embedder } = await makeSeeded();
    const svc = new RetrievalService(store, embedder);

    const r1 = await svc.retrieve(QUERY, { k: 5, now: Date.parse("2026-06-02T10:00:00Z") });
    const r2 = await svc.retrieve(QUERY, { k: 5, now: Date.parse("2026-06-02T10:00:00Z") });

    expect(r1.map((r) => r.memoryId)).toEqual(r2.map((r) => r.memoryId));
    expect(r1.every((r) => r.scoreBreakdown.rerankerScore === undefined)).toBe(true);
  });
});

describe("RetrievalService - reranker degrades gracefully", () => {
  it("falls back to first-stage order when the reranker throws", async () => {
    const { store, embedder } = await makeSeeded();
    const now = Date.parse("2026-06-02T10:00:00Z");

    const base = await new RetrievalService(store, embedder).retrieve(QUERY, { k: 5, now });

    const failing = new RetrievalService(store, embedder, undefined, new FakeReranker().alwaysThrow());
    const failed = await failing.retrieve(QUERY, { k: 5, now });

    expect(failed.map((r) => r.memoryId)).toEqual(base.map((r) => r.memoryId));
    expect(failed.every((r) => r.scoreBreakdown.rerankerScore === undefined)).toBe(true);
  });

  it("falls back when the reranker returns the wrong number of scores", async () => {
    const { store, embedder } = await makeSeeded();
    const now = Date.parse("2026-06-02T10:00:00Z");

    const base = await new RetrievalService(store, embedder).retrieve(QUERY, { k: 5, now });

    // Malformed reranker: always returns a single score regardless of doc count.
    const malformed: Reranker = { rerank: async () => [0.5] };
    const svc = new RetrievalService(store, embedder, undefined, malformed);
    const out = await svc.retrieve(QUERY, { k: 5, now });

    expect(out.map((r) => r.memoryId)).toEqual(base.map((r) => r.memoryId));
    expect(out.every((r) => r.scoreBreakdown.rerankerScore === undefined)).toBe(true);
  });
});
