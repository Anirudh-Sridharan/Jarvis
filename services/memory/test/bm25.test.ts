/**
 * Tests for pure-JS BM25 keyword ranking.
 */

import { describe, it, expect } from "vitest";
import { BM25Index, buildBM25Index } from "../src/search/bm25.js";

const DOCS = [
  { id: "1", text: "TypeScript is a typed superset of JavaScript" },
  { id: "2", text: "Python is a dynamic programming language" },
  { id: "3", text: "TypeScript adds static types to JavaScript projects" },
  { id: "4", text: "The quick brown fox jumps over the lazy dog" },
  { id: "5", text: "Memory management in systems programming" },
];

function makeIndex() {
  return buildBM25Index(DOCS);
}

describe("BM25Index - basic ranking", () => {
  it("returns relevant docs for 'TypeScript'", () => {
    const idx = makeIndex();
    const results = idx.search("TypeScript", 5);
    expect(results.length).toBeGreaterThan(0);
    // TypeScript docs (1, 3) should rank higher than unrelated doc (4)
    const ids = results.map((r) => r.id);
    expect(ids[0] === "1" || ids[0] === "3").toBe(true);
  });

  it("returns docs with TypeScript before doc about fox (no TypeScript)", () => {
    const idx = makeIndex();
    const results = idx.search("TypeScript", 5);
    const ids = results.map((r) => r.id);
    const tsRanks = ["1", "3"].map((id) => ids.indexOf(id)).filter((i) => i >= 0);
    const foxRank = ids.indexOf("4");
    // TypeScript docs should appear before fox doc (or fox not in results)
    if (foxRank >= 0) {
      expect(Math.min(...tsRanks)).toBeLessThan(foxRank);
    }
  });

  it("scores descend monotonically", () => {
    const idx = makeIndex();
    const results = idx.search("programming language", 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("returns empty for query with no matching terms", () => {
    const idx = makeIndex();
    const results = idx.search("zzzzzzunknown", 5);
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty query", () => {
    const idx = makeIndex();
    expect(idx.search("", 5)).toHaveLength(0);
  });

  it("caps results at k", () => {
    const idx = makeIndex();
    const results = idx.search("the", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("BM25Index - multiple terms", () => {
  it("ranks doc with more matching terms higher", () => {
    const idx = makeIndex();
    const results = idx.search("TypeScript JavaScript", 5);
    // Doc 1 has both TypeScript AND JavaScript; doc 3 also has both
    const ids = results.slice(0, 2).map((r) => r.id);
    expect(ids.includes("1") || ids.includes("3")).toBe(true);
  });
});

describe("BM25Index - addDocument / removeDocument", () => {
  it("newly added doc can be found", () => {
    const idx = new BM25Index();
    idx.addDocument("a", "hello world test");
    idx.addDocument("b", "goodbye world");
    idx.build();
    const results = idx.search("test", 5);
    expect(results[0]?.id).toBe("a");
  });

  it("removed doc is not returned", () => {
    const idx = buildBM25Index([
      { id: "del", text: "remove this document" },
      { id: "keep", text: "keep this document" },
    ]);
    idx.removeDocument("del");
    idx.build();
    const results = idx.search("remove", 5);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain("del");
  });
});

describe("BM25Index - docCount", () => {
  it("returns correct doc count", () => {
    const idx = makeIndex();
    expect(idx.docCount).toBe(DOCS.length);
  });

  it("decrements on removeDocument", () => {
    const idx = makeIndex();
    idx.removeDocument("1");
    expect(idx.docCount).toBe(DOCS.length - 1);
  });
});
