/**
 * Tests for MemoryStore: CRUD, bi-temporal queries, entity resolution, fact invalidation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder } from "../src/testing/fakes.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-memory-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  return { store, dir };
}

describe("MemoryStore - Episode", () => {
  it("upserts an episode and retrieves it", async () => {
    const { store } = makeStore();
    const ep = await store.upsertEpisode({
      text: "User asked about TypeScript generics",
      occurredAt: "2026-01-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "msg-1", confidence: 1 },
    });
    expect(ep.id).toBeTruthy();
    expect(ep.kind).toBe("episode");
    expect(ep.tier).toBe("episodic");
    const fetched = store.getEpisodeById(ep.id);
    expect(fetched?.text).toBe("User asked about TypeScript generics");
  });

  it("upsert is idempotent (same id, second upsert returns existing)", async () => {
    const { store } = makeStore();
    const ep1 = await store.upsertEpisode({
      id: "fixed-id",
      text: "Hello world",
      occurredAt: "2026-01-01T10:00:00Z",
      provenance: { source: "note", sourceId: "note-1", confidence: 1 },
    });
    const ep2 = await store.upsertEpisode({
      id: "fixed-id",
      text: "Hello world", // same id → no-op
      occurredAt: "2026-01-01T10:00:00Z",
      provenance: { source: "note", sourceId: "note-1", confidence: 1 },
    });
    expect(ep1.id).toBe(ep2.id);
  });
});

describe("MemoryStore - Fact bi-temporal", () => {
  it("upserts a fact and retrieves it", async () => {
    const { store } = makeStore();
    const fact = await store.upsertFact({
      subjectId: "entity-alex",
      predicate: "prefers",
      objectLiteral: "TypeScript",
      text: "Alex prefers TypeScript",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "msg-2", confidence: 0.9 },
    });
    expect(fact.kind).toBe("fact");
    expect(fact.validTo).toBeNull();
    expect(fact.invalidatedAt).toBeNull();
  });

  it("invalidating a fact sets validTo and invalidatedAt", async () => {
    const { store } = makeStore();
    const fact = await store.upsertFact({
      subjectId: "entity-alex",
      predicate: "manager_is",
      objectLiteral: "Bob",
      text: "Alex manager is Bob",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "msg-3", confidence: 0.9 },
    });

    const newFact = await store.upsertFact({
      subjectId: "entity-alex",
      predicate: "manager_is",
      objectLiteral: "Priya",
      text: "Alex manager is Priya",
      validFrom: "2026-06-01T00:00:00Z",
      supersedes: fact.id,
      provenance: { source: "chat", sourceId: "msg-4", confidence: 0.95 },
    });

    store.invalidateFact({
      factId: fact.id,
      validTo: "2026-06-01T00:00:00Z",
      invalidatedBy: newFact.id,
    });

    const old = store.getFactById(fact.id)!;
    expect(old.validTo).toBe("2026-06-01T00:00:00Z");
    expect(old.invalidatedAt).not.toBeNull();
    expect(old.invalidatedBy).toBe(newFact.id);

    const fresh = store.getFactById(newFact.id)!;
    expect(fresh.validTo).toBeNull();
    expect(fresh.invalidatedAt).toBeNull();
  });

  it("invalidating an already-invalidated fact is a no-op (idempotent)", async () => {
    const { store } = makeStore();
    const fact = await store.upsertFact({
      subjectId: "e1",
      predicate: "works_at",
      objectLiteral: "Acme",
      text: "Works at Acme",
      validFrom: "2025-01-01T00:00:00Z",
      provenance: { source: "note", sourceId: "n1", confidence: 1 },
    });
    store.invalidateFact({ factId: fact.id, validTo: "2025-06-01T00:00:00Z" });
    // Second invalidation should no-op
    const result = store.invalidateFact({ factId: fact.id, validTo: "2025-07-01T00:00:00Z" });
    // validTo should NOT be updated (idempotent)
    expect(result?.validTo).toBe("2025-06-01T00:00:00Z");
  });

  it("factsValidAt returns facts valid at a specific event-time", async () => {
    const { store } = makeStore();
    const subjectId = "entity-x";

    // Fact 1: valid Jan-June 2026
    const f1 = await store.upsertFact({
      subjectId,
      predicate: "role",
      objectLiteral: "junior",
      text: "Role is junior",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "s1", confidence: 0.9 },
    });
    store.invalidateFact({ factId: f1.id, validTo: "2026-06-01T00:00:00Z" });

    // Fact 2: valid June+ 2026
    await store.upsertFact({
      subjectId,
      predicate: "role",
      objectLiteral: "senior",
      text: "Role is senior",
      validFrom: "2026-06-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "s2", confidence: 0.95 },
    });

    // As of Feb 2026 → only "junior"
    const feb = store.factsValidAt(subjectId, "2026-02-01T00:00:00Z", "role");
    expect(feb.length).toBe(1);
    expect(feb[0]?.objectLiteral).toBe("junior");

    // As of July 2026 → only "senior"
    const jul = store.factsValidAt(subjectId, "2026-07-01T00:00:00Z", "role");
    expect(jul.length).toBe(1);
    expect(jul[0]?.objectLiteral).toBe("senior");
  });

  it("getFactHistory returns all versions ordered oldest-first", async () => {
    const { store } = makeStore();
    const subjectId = "entity-hist";
    await store.upsertFact({
      subjectId,
      predicate: "level",
      objectLiteral: "1",
      text: "Level 1",
      validFrom: "2024-01-01T00:00:00Z",
      provenance: { source: "note", sourceId: "h1", confidence: 1 },
    });
    await store.upsertFact({
      subjectId,
      predicate: "level",
      objectLiteral: "2",
      text: "Level 2",
      validFrom: "2025-01-01T00:00:00Z",
      provenance: { source: "note", sourceId: "h2", confidence: 1 },
    });
    const history = store.getFactHistory(subjectId, "level");
    expect(history.length).toBe(2);
    expect(history[0]?.objectLiteral).toBe("1");
    expect(history[1]?.objectLiteral).toBe("2");
  });
});

describe("MemoryStore - Entity resolution", () => {
  it("resolves by exact name (step 2)", async () => {
    const { store } = makeStore();
    const e1 = await store.upsertEntity({
      name: "Alex",
      entityType: "person",
      text: "Alex Sample",
      provenance: { source: "chat", sourceId: "s1", confidence: 1 },
    });
    // Same name → should return the same entity
    const e2 = await store.upsertEntity({
      name: "alex", // different case → normalized
      entityType: "person",
      text: "alex sample",
      provenance: { source: "chat", sourceId: "s2", confidence: 1 },
    });
    expect(e1.id).toBe(e2.id);
  });

  it("creates a new entity for different entityType", async () => {
    const { store } = makeStore();
    const e1 = await store.upsertEntity({
      name: "TypeScript",
      entityType: "tool",
      text: "TypeScript language",
      provenance: { source: "note", sourceId: "n1", confidence: 1 },
    });
    const e2 = await store.upsertEntity({
      name: "TypeScript",
      entityType: "topic",
      text: "TypeScript topic",
      provenance: { source: "note", sourceId: "n2", confidence: 1 },
    });
    expect(e1.id).not.toBe(e2.id);
  });
});

describe("MemoryStore - Procedural block", () => {
  it("writes and reads the procedural block", () => {
    const { store } = makeStore();
    const block = store.writeProceduralBlock(
      "# Work style\n- Prefer mornings",
      ["fact-1"],
      "feature-6",
    );
    expect(block.version).toBe(1);
    expect(block.markdown).toContain("Prefer mornings");
    const read = store.getProceduralBlock();
    expect(read?.version).toBe(1);
  });

  it("increments version on each write", () => {
    const { store } = makeStore();
    store.writeProceduralBlock("v1", [], "feature-6");
    store.writeProceduralBlock("v2", [], "feature-6");
    const block = store.getProceduralBlock()!;
    expect(block.version).toBe(2);
    expect(block.markdown).toBe("v2");
  });

  it("returns null when no procedural block exists", () => {
    const { store } = makeStore();
    expect(store.getProceduralBlock()).toBeNull();
  });
});

describe("MemoryStore - keyword search liveness (BM25)", () => {
  it("stops surfacing a fact after invalidation (cache is invalidated)", async () => {
    const { store } = makeStore();
    const fact = await store.upsertFact({
      subjectId: "e-bm25",
      predicate: "prefers",
      objectLiteral: "zebra snorkeling",
      text: "User prefers zebra snorkeling on weekends",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "kw-1", confidence: 0.9 },
    });

    // Build the cached index while the fact is live
    let results = store.keywordSearch({ query: "zebra snorkeling", k: 5 });
    expect(results.some((r) => r.node.id === fact.id)).toBe(true);

    // Invalidate — the cached BM25 index must not keep serving the stale entry
    store.invalidateFact({ factId: fact.id, validTo: new Date().toISOString() });
    results = store.keywordSearch({ query: "zebra snorkeling", k: 5 });
    expect(results.some((r) => r.node.id === fact.id)).toBe(false);
  });

  it("honors includeInvalidated: invalidated facts surface only when requested", async () => {
    const { store } = makeStore();
    const fact = await store.upsertFact({
      subjectId: "e-bm25-2",
      predicate: "works_at",
      objectLiteral: "Quaxolotl Labs",
      text: "User works at Quaxolotl Labs",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "kw-2", confidence: 0.9 },
    });
    store.invalidateFact({ factId: fact.id, validTo: new Date().toISOString() });

    const liveOnly = store.keywordSearch({ query: "Quaxolotl", k: 5 });
    expect(liveOnly.some((r) => r.node.id === fact.id)).toBe(false);

    const withInvalidated = store.keywordSearch({
      query: "Quaxolotl",
      k: 5,
      includeInvalidated: true,
    });
    expect(withInvalidated.some((r) => r.node.id === fact.id)).toBe(true);
  });
});

describe("MemoryStore - upsertFact never replaces (no hard delete)", () => {
  it("throws on duplicate id and preserves the original row", async () => {
    const { store } = makeStore();
    await store.upsertFact({
      id: "fixed-fact-id",
      subjectId: "e-dup",
      predicate: "role",
      objectLiteral: "engineer",
      text: "Role is engineer",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "note", sourceId: "dup-1", confidence: 1 },
    });
    store.invalidateFact({ factId: "fixed-fact-id", validTo: "2026-02-01T00:00:00Z" });

    await expect(
      store.upsertFact({
        id: "fixed-fact-id",
        subjectId: "e-dup",
        predicate: "role",
        objectLiteral: "manager",
        text: "Role is manager",
        validFrom: "2026-03-01T00:00:00Z",
        provenance: { source: "note", sourceId: "dup-2", confidence: 1 },
      }),
    ).rejects.toThrow();

    // Original row untouched: invalidation history NOT reset by a REPLACE
    const row = store.getFactById("fixed-fact-id")!;
    expect(row.text).toBe("Role is engineer");
    expect(row.invalidatedAt).not.toBeNull();
    expect(row.validTo).toBe("2026-02-01T00:00:00Z");
  });

  it("maps source_trust onto Fact.sourceTrust (default 0.5)", async () => {
    const { store } = makeStore();
    const trusted = await store.upsertFact({
      subjectId: "e-trust",
      predicate: "manager_is",
      objectLiteral: "Priya",
      text: "Manager is Priya",
      validFrom: "2026-01-01T00:00:00Z",
      sourceTrust: 1.0,
      provenance: { source: "system", sourceId: "user-correction", confidence: 1 },
    });
    expect(trusted.sourceTrust).toBe(1.0);

    const defaulted = await store.upsertFact({
      subjectId: "e-trust",
      predicate: "likes",
      objectLiteral: "coffee",
      text: "Likes coffee",
      validFrom: "2026-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "t-2", confidence: 0.8 },
    });
    expect(defaulted.sourceTrust).toBe(0.5);
  });
});

describe("MemoryStore - entitySearch matches any entity id", () => {
  it("finds episodes linked to a non-first entity id", async () => {
    const { store } = makeStore();
    const ep = await store.upsertEpisode({
      text: "Met with Priya about the roadmap",
      occurredAt: "2026-05-01T10:00:00Z",
      entityIds: ["ent-priya"],
      provenance: { source: "calendar", sourceId: "evt-1", confidence: 0.9 },
    });

    // "ent-priya" is the SECOND id in the list — must still match
    const results = store.entitySearch({ entityIds: ["ent-other", "ent-priya"], k: 10 });
    expect(results.some((r) => r.node.id === ep.id)).toBe(true);
  });

  it("returns empty for an empty entityIds list", () => {
    const { store } = makeStore();
    expect(store.entitySearch({ entityIds: [], k: 10 })).toEqual([]);
  });
});

describe("MemoryStore - vectorSearch asOf bounds", () => {
  it("excludes facts whose valid_from is after asOf", async () => {
    const { store } = makeStore();
    const embedder = new FakeEmbedder();
    const fact = await store.upsertFact({
      subjectId: "e-asof",
      predicate: "role",
      objectLiteral: "senior",
      text: "Role became senior in June",
      validFrom: "2026-06-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "asof-1", confidence: 0.9 },
    });
    const [queryVec] = await embedder.embed([fact.text]);

    // asOf BEFORE validFrom → the fact was not yet true; must be excluded
    const before = store.vectorSearch({ query: queryVec!, k: 5, asOf: "2026-01-01T00:00:00Z" });
    expect(before.some((r) => r.node.id === fact.id)).toBe(false);

    // asOf AFTER validFrom → included
    const after = store.vectorSearch({ query: queryVec!, k: 5, asOf: "2026-07-01T00:00:00Z" });
    expect(after.some((r) => r.node.id === fact.id)).toBe(true);
  });
});
