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
import { FakeEmbedder } from "../src/testing/fakes.js";

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
