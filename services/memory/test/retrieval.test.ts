/**
 * Tests for hybrid retrieval: fusion ranking, MMR, placement hints.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { RetrievalService } from "../src/retrieval/retrieval.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";
import { CaptureService } from "../src/capture/capture.js";
import { ConsolidationService } from "../src/consolidation/consolidation.js";

function makeRetrieval() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-retrieval-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const retrieval = new RetrievalService(store, embedder);
  return { store, retrieval, embedder };
}

describe("RetrievalService - basic retrieval", () => {
  it("returns empty array for empty store", async () => {
    const { retrieval } = makeRetrieval();
    const results = await retrieval.retrieve("TypeScript");
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty query string", async () => {
    const { retrieval } = makeRetrieval();
    const results = await retrieval.retrieve("");
    expect(results).toHaveLength(0);
  });

  it("returns results after inserting episodes", async () => {
    const { store, retrieval } = makeRetrieval();
    await store.upsertEpisode({
      text: "User prefers TypeScript over Python for type safety",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.9 },
    });
    await store.upsertEpisode({
      text: "User enjoys morning coffee and reading",
      occurredAt: "2026-06-01T08:00:00Z",
      provenance: { source: "note", sourceId: "note-1", confidence: 0.8 },
    });

    const results = await retrieval.retrieve("TypeScript programming", { k: 5 });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("RetrievalService - placement hints", () => {
  it("rank 0 gets edge_top, rank 1 gets edge_bottom, rest get middle", async () => {
    const { store, retrieval } = makeRetrieval();
    // Insert several episodes
    for (let i = 0; i < 5; i++) {
      await store.upsertEpisode({
        text: `Episode ${i} about TypeScript memory retrieval testing`,
        occurredAt: `2026-0${i + 1}-01T10:00:00Z`,
        provenance: { source: "chat", sourceId: `ep-${i}`, confidence: 0.8 },
      });
    }

    const results = await retrieval.retrieve("TypeScript memory", { k: 5 });
    if (results.length > 0) {
      expect(results[0]?.placementHint).toBe("edge_top");
    }
    if (results.length > 1) {
      expect(results[1]?.placementHint).toBe("edge_bottom");
    }
    for (let i = 2; i < results.length; i++) {
      expect(results[i]?.placementHint).toBe("middle");
    }
  });
});

describe("RetrievalService - ranking favors recent+important", () => {
  it("recent episode scores higher than same-content stale one", async () => {
    const { store, retrieval } = makeRetrieval();

    // Create a recent episode (1 hour ago)
    const recentTime = new Date(Date.now() - 3_600_000).toISOString();
    // Create a stale episode (5 days ago)
    const staleTime = new Date(Date.now() - 5 * 24 * 3_600_000).toISOString();

    const recentEp = await store.upsertEpisode({
      text: "TypeScript is great for large projects",
      occurredAt: recentTime,
      provenance: { source: "chat", sourceId: "recent-1", confidence: 0.9 },
    });
    // Manually set importance and lastAccessedAt for the recent one
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare(`UPDATE episodes SET importance = 8, last_accessed_at = ? WHERE id = ?`)
      .run(Date.now() - 3_600_000, recentEp.id);

    const staleEp = await store.upsertEpisode({
      text: "TypeScript is great for large projects too",
      occurredAt: staleTime,
      provenance: { source: "chat", sourceId: "stale-1", confidence: 0.9 },
    });
    db.prepare(`UPDATE episodes SET importance = 3, last_accessed_at = ? WHERE id = ?`)
      .run(Date.now() - 5 * 24 * 3_600_000, staleEp.id);

    const results = await retrieval.retrieve("TypeScript large projects", {
      k: 5,
      now: Date.now(),
    });

    if (results.length >= 2) {
      // Recent+important should rank first
      expect(results[0]?.memoryId).toBe(recentEp.id);
    }
  });
});

describe("RetrievalService - k limit", () => {
  it("respects the k parameter", async () => {
    const { store, retrieval } = makeRetrieval();
    for (let i = 0; i < 10; i++) {
      await store.upsertEpisode({
        text: `TypeScript memory fact number ${i}`,
        occurredAt: `2026-0${(i % 9) + 1}-01T10:00:00Z`,
        provenance: { source: "note", sourceId: `n-${i}`, confidence: 0.8 },
      });
    }
    const results = await retrieval.retrieve("TypeScript memory", { k: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

describe("RetrievalService - getProceduralBlock", () => {
  it("returns empty string when no procedural block exists", () => {
    const { retrieval } = makeRetrieval();
    expect(retrieval.getProceduralBlock()).toBe("");
  });

  it("returns the procedural block markdown after writing", () => {
    const { store, retrieval } = makeRetrieval();
    store.writeProceduralBlock("# My work style\n- Prefer TypeScript", [], "feature-6");
    expect(retrieval.getProceduralBlock()).toContain("Prefer TypeScript");
  });
});

describe("RetrievalService - degrades to BM25/entity when embedder is unavailable", () => {
  it("returns keyword results when the embedder returns no vectors", async () => {
    const { store } = makeRetrieval();
    await store.upsertEpisode({
      text: "User prefers TypeScript over Python for type safety",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.9 },
    });

    // Embedder like the dashboard BFF's no-op: returns an empty batch
    const emptyEmbedder = { embed: async (_texts: string[]) => [] as number[][] };
    const degraded = new RetrievalService(store, emptyEmbedder);

    const results = await degraded.retrieve("TypeScript type safety", { k: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain("TypeScript");
  });

  it("returns keyword results when the embedder throws", async () => {
    const { store } = makeRetrieval();
    await store.upsertEpisode({
      text: "Whoop recovery score was 85 this morning",
      occurredAt: "2026-06-01T08:00:00Z",
      provenance: { source: "note", sourceId: "n-1", confidence: 0.9 },
    });

    const throwingEmbedder = {
      embed: async (_texts: string[]): Promise<number[][]> => {
        throw new Error("embedder down");
      },
    };
    const degraded = new RetrievalService(store, throwingEmbedder);

    const results = await degraded.retrieve("Whoop recovery score", { k: 5 });
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("RetrievalService - access tracking", () => {
  it("increments access_count and last_accessed_at for returned memories", async () => {
    const { store, retrieval } = makeRetrieval();
    const ep = await store.upsertEpisode({
      text: "User prefers TypeScript for backend services",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "touch-1", confidence: 0.9 },
    });

    const results = await retrieval.retrieve("TypeScript backend services", { k: 5 });
    expect(results.some((r) => r.memoryId === ep.id)).toBe(true);

    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const row = db
      .prepare(`SELECT access_count, last_accessed_at FROM episodes WHERE id = ?`)
      .get(ep.id) as { access_count: number; last_accessed_at: number };
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).toBeGreaterThan(0);
  });

  it("trackAccess: false leaves access_count and last_accessed_at untouched (WR-01)", async () => {
    const { store, retrieval } = makeRetrieval();
    const ep = await store.upsertEpisode({
      text: "User prefers TypeScript for backend services",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "touch-2", confidence: 0.9 },
    });

    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const before = db
      .prepare(`SELECT access_count, last_accessed_at FROM episodes WHERE id = ?`)
      .get(ep.id) as { access_count: number; last_accessed_at: number };

    // Read-only measurement retrieval: the episode is returned but NOT touched.
    const results = await retrieval.retrieve("TypeScript backend services", {
      k: 5,
      trackAccess: false,
    });
    expect(results.some((r) => r.memoryId === ep.id)).toBe(true);

    const after = db
      .prepare(`SELECT access_count, last_accessed_at FROM episodes WHERE id = ?`)
      .get(ep.id) as { access_count: number; last_accessed_at: number };
    expect(after.access_count).toBe(before.access_count);
    expect(after.last_accessed_at).toBe(before.last_accessed_at);

    // Default behavior is unchanged: an ordinary retrieval still bumps both.
    await retrieval.retrieve("TypeScript backend services", { k: 5 });
    const bumped = db
      .prepare(`SELECT access_count, last_accessed_at FROM episodes WHERE id = ?`)
      .get(ep.id) as { access_count: number; last_accessed_at: number };
    expect(bumped.access_count).toBe(before.access_count + 1);
  });
});

describe("MemoryStore.pendingSearch() - MEM-01 pending-record search", () => {
  it("returns [] when the pending set is empty", () => {
    const { store } = makeRetrieval();
    const results = store.pendingSearch({ query: "TypeScript", k: 5 });
    expect(results).toHaveLength(0);
  });

  it("finds a not-yet-consolidated record via keyword match", async () => {
    const { store, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    await capture.captureNote({
      text: "The user just mentioned they prefer TypeScript for new projects",
      noteId: "pending-note-1",
    });

    const results = store.pendingSearch({ query: "TypeScript projects", k: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.record.text.includes("TypeScript"))).toBe(true);
    expect(results.some((r) => r.bm25Raw !== undefined)).toBe(true);
  });

  it("finds a not-yet-consolidated record via vector match", async () => {
    const { store, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    const text = "The user just mentioned they prefer TypeScript for new projects";
    await capture.captureNote({ text, noteId: "pending-note-2" });

    const [queryVec] = await embedder.embed([text]);
    const results = store.pendingSearch({ query: "unrelated words", queryVec, k: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.record.text === text && r.vecCosine !== undefined)).toBe(true);
  });

  it("still returns a dead-lettered record (never permanently unrecallable)", async () => {
    const { store, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    const result = await capture.captureNote({
      text: "A record that failed extraction repeatedly about quantum computing",
      noteId: "dead-letter-note-1",
    });
    store.deadLetterRecord(result.record.id, { attempts: 5, error: "simulated failure" });

    const results = store.pendingSearch({ query: "quantum computing", k: 5 });
    expect(results.some((r) => r.record.id === result.record.id)).toBe(true);
    const found = results.find((r) => r.record.id === result.record.id);
    expect(found?.record.deadLetter).toBe(true);
  });

  it("degrades to [] rather than throwing when a read fails", () => {
    const { store } = makeRetrieval();
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    // Drop the table underneath the store to force a read failure.
    db.exec(`DROP TABLE experience_records`);
    expect(() => store.pendingSearch({ query: "anything", k: 5 })).not.toThrow();
    expect(store.pendingSearch({ query: "anything", k: 5 })).toEqual([]);
  });
});

describe("RetrievalService - MEM-01 pendingRetriever (4th retriever + provisional discount)", () => {
  it("includes a pending candidate in retrieve() output by default", async () => {
    const { store, retrieval, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    await capture.captureNote({
      text: "The user just said they are switching to a new email provider",
      noteId: "pending-fusion-1",
    });

    const results = await retrieval.retrieve("switching email provider", { k: 5 });
    expect(results.some((r) => r.kind === "pending")).toBe(true);
  });

  it("excludes pending candidates when includePending is false", async () => {
    const { store, retrieval, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    await capture.captureNote({
      text: "The user just said they are switching to a new email provider",
      noteId: "pending-fusion-2",
    });

    const results = await retrieval.retrieve("switching email provider", {
      k: 5,
      includePending: false,
    });
    expect(results.some((r) => r.kind === "pending")).toBe(false);
  });

  it("returns existing three-retriever results unchanged when no pending records exist", async () => {
    const { store, retrieval } = makeRetrieval();
    await store.upsertEpisode({
      text: "User prefers TypeScript over Python for type safety",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.9 },
    });
    const results = await retrieval.retrieve("TypeScript programming", { k: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.kind !== "pending")).toBe(true);
  });

  it("a pending candidate never outranks a fact candidate with equal underlying signals", async () => {
    const { store, retrieval, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    const NOW = 1_700_000_000_000;
    const text = "Equal-signal fixture text about a rare topic xyzzyplugh";

    const captured = await capture.captureNote({ text, noteId: "equal-signal-pending" });
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    // Align the pending record's recency clock to NOW (same as the fact below).
    db.prepare(`UPDATE experience_records SET ingested_at = ? WHERE id = ?`).run(
      new Date(NOW).toISOString(),
      captured.record.id,
    );

    const fact = await store.upsertFact({
      subjectId: "self",
      predicate: "mentions",
      objectLiteral: "xyzzyplugh",
      text,
      validFrom: new Date(NOW).toISOString(),
      provenance: { source: "system", sourceId: "test", confidence: 1 },
    });
    // upsertFact() hardcodes importance=5 (matches pending's default) and
    // last_accessed_at=Date.now() — align it to NOW for an exact recency match.
    db.prepare(`UPDATE facts SET last_accessed_at = ? WHERE id = ?`).run(NOW, fact.id);

    const results = await retrieval.retrieve(text, { k: 10, now: NOW });
    const pendingResult = results.find((r) => r.kind === "pending");
    const factResult = results.find((r) => r.kind === "fact");
    expect(pendingResult).toBeDefined();
    expect(factResult).toBeDefined();
    expect(pendingResult!.fusedScore).toBeLessThan(factResult!.fusedScore);
  });

  it("the SAME captured text transitions from pending to a promoted graph node after consolidation", async () => {
    const { store, retrieval, embedder } = makeRetrieval();
    const capture = new CaptureService(store, embedder);
    const llm = new FakeLlm();
    const marker = "eval-canary-pending-5528";
    // FakeLlm's default extraction is a fixed "User prefers TypeScript" fact —
    // the captured record's own literal text never reaches the graph unless
    // an override is registered on a distinctive substring of its body.
    // reflectInsights() embeds the same raw record text under "Recent
    // experiences:" — suppress that prompt explicitly (checked first) so the
    // marker only ever promotes into a single fact, not a duplicate episode.
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        {
          entity: "self",
          predicate: "mentions",
          object: marker,
          text: `Captured note mentions ${marker}`,
          confidence: 0.9,
        },
      ]),
    );

    await capture.captureNote({
      text: `Reminder about ${marker} for the team`,
      noteId: "pending-transition-1",
    });

    // Pre-consolidation half (MEM-01's already-proven path): the record
    // surfaces as a provisional "pending" candidate before consolidation runs.
    const before = await retrieval.retrieve(`${marker} team`, { k: 5 });
    const pendingHit = before.find((r) => r.kind === "pending");
    expect(pendingHit).toBeDefined();
    expect(pendingHit?.text).toContain(marker);

    const consolidation = new ConsolidationService(store, llm, embedder);
    await consolidation.run("manual"); // force-consolidate — the MEM-06 gap

    // Post-consolidation half (MEM-06's gap): the SAME text is now retrievable
    // as a promoted fact, not merely "some pending row exists somewhere".
    const after = await retrieval.retrieve(`${marker} team`, { k: 5 });
    const factHit = after.find((r) => r.kind === "fact" && r.text.includes(marker));
    expect(factHit).toBeDefined();
    // The disappearance of the pending row here is expected and correct:
    // MemoryStore.pendingSearch() selects WHERE consolidation_pending = 1 OR
    // dead_letter = 1, so a legitimately-promoted record leaves that pool —
    // which is exactly why this post-consolidation half is a distinct proof,
    // not redundant with the pre-consolidation case above.
    expect(after.some((r) => r.kind === "pending" && r.text.includes(marker))).toBe(false);
  });
});

describe("RetrievalService - fusion score breakdown", () => {
  it("returned memories include score breakdown", async () => {
    const { store, retrieval } = makeRetrieval();
    await store.upsertEpisode({
      text: "User often talks about machine learning",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "ml-1", confidence: 0.9 },
    });
    const results = await retrieval.retrieve("machine learning");
    if (results.length > 0) {
      const r = results[0]!;
      expect(r.scoreBreakdown).toBeDefined();
      expect(r.scoreBreakdown.recency).toBeGreaterThan(0);
      expect(r.scoreBreakdown.importance).toBeGreaterThan(0);
      expect(r.fusedScore).toBeGreaterThan(0);
    }
  });
});
