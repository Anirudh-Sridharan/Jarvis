/**
 * Tests for the sqlite-vec acceleration path.
 *
 * Proves the extension actually loads here (vec_nodes mirror gets created), KNN
 * orders by cosine similarity, and invalidated facts are filtered out of vec
 * search just like the brute-force path.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { VecIndex } from "../src/db/vecIndex.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder } from "../src/testing/fakes.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "jarvis-vec-test-"));
}

describe("VecIndex - exact cosine KNN", () => {
  it("loads sqlite-vec and orders results by cosine similarity", () => {
    const db = openDatabase(tmp());
    const vec = new VecIndex(db);
    expect(vec.tryLoad()).toBe(true); // platform prebuilt present

    vec.upsert("ep:a", [1, 0, 0, 0]);
    vec.upsert("fact:b", [0, 1, 0, 0]);
    vec.upsert("ep:c", [0.9, 0.1, 0, 0]);

    const hits = vec.search([1, 0, 0, 0], 2);
    expect(hits.map((h) => h.id)).toEqual(["ep:a", "ep:c"]);
    expect(hits[0]?.score).toBeCloseTo(1, 4); // identical vector → cosine 1
  });
});

describe("MemoryStore - vector search via sqlite-vec", () => {
  it("mirrors embeddings into a vec0 table and retrieves them", async () => {
    const db = openDatabase(tmp());
    const store = new MemoryStore(db, new FakeEmbedder());

    await store.upsertEpisode({
      text: "hello vector world",
      occurredAt: "2026-06-01T10:00:00Z",
      provenance: { source: "chat", sourceId: "v1", confidence: 0.9 },
    });

    // The mirror table exists and holds the episode — proves the vec path is live.
    const row = db.prepare("SELECT count(*) AS n FROM vec_nodes").get() as { n: number };
    expect(row.n).toBe(1);

    const [q] = await new FakeEmbedder().embed(["hello vector world"]);
    const res = store.vectorSearch({ query: q!, k: 5 });
    expect(res).toHaveLength(1);
    expect(res[0]?.node.text).toBe("hello vector world");
  });

  it("excludes invalidated facts from vec search", async () => {
    const db = openDatabase(tmp());
    const store = new MemoryStore(db, new FakeEmbedder());

    const fact = await store.upsertFact({
      subjectId: "self",
      predicate: "likes",
      objectLiteral: "tea",
      text: "User likes tea",
      validFrom: "2026-06-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "f1", confidence: 0.9 },
    });

    const [q] = await new FakeEmbedder().embed(["User likes tea"]);
    expect(store.vectorSearch({ query: q!, k: 5 }).some((r) => r.node.id === fact.id)).toBe(true);

    store.invalidateFact({ factId: fact.id, validTo: "2026-06-02T00:00:00Z" });
    // The mirror still holds the row; the validity filter must drop it.
    expect(store.vectorSearch({ query: q!, k: 5 }).some((r) => r.node.id === fact.id)).toBe(false);
  });
});
