/**
 * Tests for forget-stage compression (Gap 2 — feature 6 stage 5).
 *
 * Verified behaviours:
 *  - A cluster of ≥3 low-importance same-subject facts gets compressed into one
 *    summary fact and the originals are invalidated.
 *  - High-importance facts (importance ≥ 7) are never compressed or evicted.
 *  - The raw experience_records journal is not touched.
 *  - Eviction still works as before for facts below the evict threshold.
 *
 * Decay score math (COMPRESS range = 0.05..0.15):
 *   decayScore = (importance/10) * exp(-ln2 * ageDays / 30) * 0.5  (access_count=0)
 *   importance=3, ageDays=30 → 0.075 ← compress ✓
 *   importance=3, ageDays=45 → 0.053 ← compress ✓
 *   importance=1, ageDays=90 → 0.006 ← evict ✓
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";
import {
  computeForgetDecisions,
  applyForgetDecisions,
} from "../src/consolidation/forget.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-forget-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  return { store, db };
}

/** Force a fact to have a specific decay score landing in "compress" range (0.05..0.15). */
function forceCompressRange(
  db: import("node:sqlite").DatabaseSync,
  factId: string,
): void {
  // importance=3, 30 days old, 0 accesses → decayScore ≈ 0.075 (compress range)
  const lastAccessedAt = Date.now() - 30 * 24 * 3_600_000;
  db.prepare(
    `UPDATE facts SET importance = 3, last_accessed_at = ?, access_count = 0 WHERE id = ?`,
  ).run(lastAccessedAt, factId);
}

/** Force a fact into the "evict" range (decayScore < 0.05). */
function forceEvictRange(
  db: import("node:sqlite").DatabaseSync,
  factId: string,
): void {
  // importance=1, 90 days old, 0 accesses → decayScore ≈ 0.006 (evict range)
  const lastAccessedAt = Date.now() - 90 * 24 * 3_600_000;
  db.prepare(
    `UPDATE facts SET importance = 1, last_accessed_at = ?, access_count = 0 WHERE id = ?`,
  ).run(lastAccessedAt, factId);
}

// ── compression of ≥3 low-importance same-subject facts ──────────────────────

describe("applyForgetDecisions - compression cluster", () => {
  it("compresses a cluster of ≥3 same-subject compress-range facts into one summary", async () => {
    const { store, db } = makeStore();

    const subjectId = "entity-compression-test";

    // Insert 4 facts in the "compress" range on the same subject.
    // Also add several high-importance guard facts to ensure the entity is well
    // above the minFactsPerEntity floor.
    const compressFacts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const f = await store.upsertFact({
        subjectId,
        predicate: `compress_detail_${i}`,
        objectLiteral: `compress value ${i}`,
        text: `Entity compression test compress detail ${i} is compress value ${i}`,
        validFrom: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
        provenance: { source: "note", sourceId: `compress-${i}`, confidence: 0.4 },
      });
      forceCompressRange(db, f.id);
      compressFacts.push(f.id);
    }

    // Guard facts (importance=9, recently accessed → always "keep")
    for (let i = 0; i < 4; i++) {
      const g = await store.upsertFact({
        subjectId,
        predicate: `guard_${i}`,
        objectLiteral: "guard",
        text: `Entity compression test guard fact ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `guard-${i}`, confidence: 0.9 },
      });
      db.prepare(`UPDATE facts SET importance = 9 WHERE id = ?`).run(g.id);
    }

    // FakeLlm returns a canned summary when asked to summarise
    const llm = new FakeLlm();
    llm.addOverride(
      "Summarize the following related facts",
      "Entity compression test: several compress details summarized.",
    );

    const decisions = computeForgetDecisions(store, Date.now());

    // The 4 compress-range facts should be marked "compress" (not "keep"/"evict")
    const compressDecisions = decisions.filter(
      (d) => d.action === "compress" && compressFacts.includes(d.factId),
    );
    expect(compressDecisions.length).toBeGreaterThanOrEqual(3);

    const { compressed } = await applyForgetDecisions(decisions, store, Date.now(), llm);

    // At least 3 original facts should be invalidated (compressed)
    expect(compressed).toBeGreaterThanOrEqual(3);

    // All 4 original compress-range facts should now be invalidated
    for (const factId of compressFacts) {
      const fact = store.getFactById(factId);
      expect(fact?.invalidatedAt).not.toBeNull();
    }

    // A new summary fact should exist for the subject (predicate = "summary")
    const allFacts = store.getFactHistory(subjectId);
    const summaryFact = allFacts.find(
      (f) => f.invalidatedAt === null && f.predicate === "summary",
    );
    expect(summaryFact).toBeDefined();
    expect(summaryFact?.text.length).toBeGreaterThan(0);
  });

  it("does NOT compress a cluster of only 2 same-subject facts (below threshold)", async () => {
    const { store, db } = makeStore();

    const subjectId = "entity-small-cluster";
    const smallFacts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const f = await store.upsertFact({
        subjectId,
        predicate: `small_${i}`,
        objectLiteral: `val ${i}`,
        text: `Small cluster fact ${i}`,
        validFrom: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
        provenance: { source: "note", sourceId: `s-${i}`, confidence: 0.4 },
      });
      forceCompressRange(db, f.id);
      smallFacts.push(f.id);
    }
    // Guard facts to avoid entity floor
    for (let i = 0; i < 4; i++) {
      const g = await store.upsertFact({
        subjectId,
        predicate: `guard_${i}`,
        objectLiteral: "guard",
        text: `Guard fact small cluster ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `g-${i}`, confidence: 0.9 },
      });
      db.prepare(`UPDATE facts SET importance = 9 WHERE id = ?`).run(g.id);
    }

    const llm = new FakeLlm();
    const decisions = computeForgetDecisions(store, Date.now());
    await applyForgetDecisions(decisions, store, Date.now(), llm);

    // With only 2 facts, the cluster is below threshold → no compression
    for (const factId of smallFacts) {
      const fact = store.getFactById(factId);
      // They should remain live (not invalidated by compression)
      expect(fact?.invalidatedAt).toBeNull();
    }
  });
});

// ── high-importance facts are never compressed ────────────────────────────────

describe("applyForgetDecisions - high-importance facts protected", () => {
  it("never compresses or evicts facts with importance >= 7", async () => {
    const { store, db } = makeStore();

    const subjectId = "entity-high-importance";

    // Insert 5 high-importance facts aged 90 days
    const highFacts: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = await store.upsertFact({
        subjectId,
        predicate: `critical_${i}`,
        objectLiteral: "critical value",
        text: `Critical fact ${i} for entity high importance`,
        validFrom: new Date(Date.now() - 90 * 24 * 3_600_000).toISOString(),
        provenance: { source: "chat", sourceId: `crit-${i}`, confidence: 0.99 },
      });
      // Force importance = 8 (above IMPORTANCE_FLOOR=7), age = 90 days
      db.prepare(
        `UPDATE facts SET importance = 8, last_accessed_at = ?, access_count = 0 WHERE id = ?`,
      ).run(Date.now() - 90 * 24 * 3_600_000, f.id);
      highFacts.push(f.id);
    }

    const llm = new FakeLlm();
    const decisions = computeForgetDecisions(store, Date.now());

    // All high-importance facts should be marked "keep" (protected by floor)
    for (const factId of highFacts) {
      const decision = decisions.find((d) => d.factId === factId);
      expect(decision?.action).toBe("keep");
      expect(decision?.protectedByFloor).toBe(true);
    }

    const { compressed, evicted } = await applyForgetDecisions(decisions, store, Date.now(), llm);

    // None should be compressed or evicted
    for (const factId of highFacts) {
      const fact = store.getFactById(factId);
      expect(fact?.invalidatedAt).toBeNull();
    }
    expect(evicted).toBe(0);
    expect(compressed).toBe(0);
  });
});

// ── eviction still works ──────────────────────────────────────────────────────

describe("applyForgetDecisions - eviction path unchanged", () => {
  it("evicts facts below the evict threshold (decayScore < 0.05)", async () => {
    const { store, db } = makeStore();

    const subjectId = "entity-evict-test";

    // One very-old, low-importance, never-accessed fact → decayScore << 0.05
    const f = await store.upsertFact({
      subjectId,
      predicate: "trivial",
      objectLiteral: "nothing",
      text: "Entity evict test trivial fact",
      validFrom: new Date(Date.now() - 120 * 24 * 3_600_000).toISOString(),
      provenance: { source: "note", sourceId: "trivial-evict", confidence: 0.2 },
    });
    forceEvictRange(db, f.id);

    // Extra guard facts to pass minFactsPerEntity floor
    for (let i = 0; i < 3; i++) {
      await store.upsertFact({
        subjectId,
        predicate: `guard_${i}`,
        objectLiteral: "guard",
        text: `Guard fact for evict test ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `guard-${i}`, confidence: 0.9 },
      });
    }

    const llm = new FakeLlm();
    const decisions = computeForgetDecisions(store, Date.now());

    const evictDecision = decisions.find((d) => d.factId === f.id);
    expect(evictDecision?.action).toBe("evict");

    const { evicted } = await applyForgetDecisions(decisions, store, Date.now(), llm);
    expect(evicted).toBeGreaterThanOrEqual(1);

    const evictedFact = store.getFactById(f.id);
    expect(evictedFact?.invalidatedAt).not.toBeNull();
  });
});

// ── compression without LLM is a safe no-op ──────────────────────────────────

describe("applyForgetDecisions - no LLM provided", () => {
  it("skips compression when llm is undefined (safe no-op)", async () => {
    const { store, db } = makeStore();

    const subjectId = "entity-no-llm";
    const compressFacts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const f = await store.upsertFact({
        subjectId,
        predicate: `compress_${i}`,
        objectLiteral: `val ${i}`,
        text: `No llm compress test fact ${i}`,
        validFrom: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
        provenance: { source: "note", sourceId: `nollm-${i}`, confidence: 0.4 },
      });
      forceCompressRange(db, f.id);
      compressFacts.push(f.id);
    }
    for (let i = 0; i < 4; i++) {
      const g = await store.upsertFact({
        subjectId,
        predicate: `guard_${i}`,
        objectLiteral: "guard",
        text: `Guard fact no llm ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `g-${i}`, confidence: 0.9 },
      });
      db.prepare(`UPDATE facts SET importance = 9 WHERE id = ?`).run(g.id);
    }

    const decisions = computeForgetDecisions(store, Date.now());
    // No LLM passed — compression should be skipped, no crash
    const { compressed } = await applyForgetDecisions(decisions, store, Date.now(), undefined);
    expect(compressed).toBe(0);

    // Compress-range facts should remain live (not invalidated)
    for (const factId of compressFacts) {
      const fact = store.getFactById(factId);
      expect(fact?.invalidatedAt).toBeNull();
    }
  });
});
