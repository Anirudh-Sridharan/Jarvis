/**
 * Feature 20 — pinned facts are never silently overwritten by consolidation.
 *
 * Covers the two enforcement points:
 *   - resolveFact: a pinned prior survives any incoming fact (recorded as
 *     historical + conflict-flagged instead of superseding).
 *   - computeForgetDecisions: pinned facts are always kept (never evicted or
 *     compressed), regardless of decay score.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";
import { resolveFact } from "../src/consolidation/contradictions.js";
import { computeForgetDecisions } from "../src/consolidation/forget.js";
import type { ExtractedFact } from "../src/types.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-pincons-test-"));
  return new MemoryStore(openDatabase(dir), new FakeEmbedder());
}

function incoming(entity: string, object: string): ExtractedFact {
  return {
    id: `extracted-${object.replace(/\s+/g, "-")}`,
    runId: "run-1",
    sourceRecordId: "rec-1",
    entity,
    predicate: "prefers",
    object,
    text: `User prefers ${object}`,
    confidence: 0.9,
    validFrom: new Date(Date.now() + 1000).toISOString(), // newer than prior
    validTo: null,
    sourceTrust: 0.9, // higher trust than prior — would normally win
  };
}

describe("resolveFact vs pinned prior", () => {
  it("a pinned prior survives a higher-trust newer incoming; incoming recorded historical + conflict flagged", async () => {
    const store = makeStore();
    const prior = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "dark roast",
      text: "User prefers dark roast",
      validFrom: new Date().toISOString(),
      sourceTrust: 0.5,
      pinned: true,
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.8 },
    });

    const result = await resolveFact(incoming("self", "light roast"), store, new FakeLlm());

    const priorAfter = store.getFactById(prior.id)!;
    expect(priorAfter.validTo).toBeNull();
    expect(priorAfter.invalidatedAt).toBeNull();
    expect(result.invalidatedIds).toHaveLength(0);
    expect(result.conflictFlagged).toBe(true);
    // Incoming is recorded but closed (historical), so derivation ignores it.
    const incomingFact = store.getFactById(result.factId)!;
    expect(incomingFact.validTo).not.toBeNull();
  });

  it("an unpinned prior is still superseded by a higher-trust incoming", async () => {
    const store = makeStore();
    const prior = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "dark roast",
      text: "User prefers dark roast",
      validFrom: new Date().toISOString(),
      sourceTrust: 0.5,
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.8 },
    });
    const result = await resolveFact(incoming("self", "light roast"), store, new FakeLlm());
    expect(result.invalidatedIds).toContain(prior.id);
  });
});

describe("forget stage vs pinned facts", () => {
  it("a pinned, stale, low-importance fact is kept (protected)", async () => {
    const store = makeStore();
    const fact = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "obscure thing",
      text: "User prefers obscure thing",
      validFrom: "2020-01-01T00:00:00.000Z",
      pinned: true,
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.3 },
    });
    // Age it: lastAccessed far in the past, importance low.
    store.rawDb.prepare(
      `UPDATE facts SET importance = 1, last_accessed_at = 0, access_count = 0 WHERE id = ?`,
    ).run(fact.id);
    // Give the entity headroom so the min-facts floor doesn't mask the pin.
    for (let i = 0; i < 3; i++) {
      await store.upsertFact({
        subjectId: "self",
        predicate: `filler_${i}`,
        objectLiteral: `filler ${i}`,
        text: `filler ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `f-${i}`, confidence: 0.9 },
      });
    }

    const decisions = computeForgetDecisions(store, Date.now());
    const d = decisions.find((x) => x.factId === fact.id)!;
    expect(d.action).toBe("keep");
    expect(d.protectedByFloor).toBe(true);
    expect(d.reason).toMatch(/pinned/);
  });

  it("an identical unpinned fact would have been evicted (the pin is what protects it)", async () => {
    const store = makeStore();
    const fact = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "obscure thing",
      text: "User prefers obscure thing",
      validFrom: "2020-01-01T00:00:00.000Z",
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.3 },
    });
    store.rawDb.prepare(
      `UPDATE facts SET importance = 1, last_accessed_at = 0, access_count = 0 WHERE id = ?`,
    ).run(fact.id);
    for (let i = 0; i < 3; i++) {
      await store.upsertFact({
        subjectId: "self",
        predicate: `filler_${i}`,
        objectLiteral: `filler ${i}`,
        text: `filler ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `f-${i}`, confidence: 0.9 },
      });
    }
    const decisions = computeForgetDecisions(store, Date.now());
    const d = decisions.find((x) => x.factId === fact.id)!;
    expect(d.action).toBe("evict");
  });
});
