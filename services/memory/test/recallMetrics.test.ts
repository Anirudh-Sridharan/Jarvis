/**
 * Tests for pure recall@k / MRR scoring (MEM-05).
 * Pure math — no SQLite, no fakes, no temp dirs.
 */

import { describe, it, expect } from "vitest";
import { evaluateRecall, type RecallJudgment } from "../src/retrieval/recallMetrics.js";

describe("evaluateRecall - per-query judgments", () => {
  it("a rank-0 hit yields found:true, rank:0, reciprocalRank:1 (never Infinity/NaN)", () => {
    const judgments: RecallJudgment[] = [
      { query: "q", targetMemoryId: "t", retrieved: [{ memoryId: "t", rank: 0 }] },
    ];
    const result = evaluateRecall(judgments);
    expect(result.perQuery[0]?.found).toBe(true);
    expect(result.perQuery[0]?.rank).toBe(0);
    expect(result.perQuery[0]?.reciprocalRank).toBe(1);
    expect(Number.isFinite(result.perQuery[0]?.reciprocalRank)).toBe(true);
  });

  it("a rank-3 hit yields reciprocalRank 0.25", () => {
    const judgments: RecallJudgment[] = [
      {
        query: "q",
        targetMemoryId: "t",
        retrieved: [
          { memoryId: "other-0", rank: 0 },
          { memoryId: "other-1", rank: 1 },
          { memoryId: "other-2", rank: 2 },
          { memoryId: "t", rank: 3 },
        ],
      },
    ];
    const result = evaluateRecall(judgments);
    expect(result.perQuery[0]?.reciprocalRank).toBe(0.25);
    expect(result.perQuery[0]?.rank).toBe(3);
    expect(result.perQuery[0]?.found).toBe(true);
  });

  it("a miss (target not in retrieved) yields found:false, rank:null, reciprocalRank:0", () => {
    const judgments: RecallJudgment[] = [
      {
        query: "q",
        targetMemoryId: "absent",
        retrieved: [
          { memoryId: "other-0", rank: 0 },
          { memoryId: "other-1", rank: 1 },
        ],
      },
    ];
    const result = evaluateRecall(judgments);
    expect(result.perQuery[0]?.found).toBe(false);
    expect(result.perQuery[0]?.rank).toBeNull();
    expect(result.perQuery[0]?.reciprocalRank).toBe(0);
  });

  it("perQuery preserves input order and echoes query/targetMemoryId", () => {
    const judgments: RecallJudgment[] = [
      { query: "first", targetMemoryId: "a", retrieved: [{ memoryId: "a", rank: 0 }] },
      { query: "second", targetMemoryId: "b", retrieved: [] },
      { query: "third", targetMemoryId: "c", retrieved: [{ memoryId: "c", rank: 2 }] },
    ];
    const result = evaluateRecall(judgments);
    expect(result.perQuery.map((p) => p.query)).toEqual(["first", "second", "third"]);
    expect(result.perQuery.map((p) => p.targetMemoryId)).toEqual(["a", "b", "c"]);
  });
});

describe("evaluateRecall - aggregates", () => {
  it("returns zeros for an empty judgment list (no division by zero)", () => {
    const result = evaluateRecall([]);
    expect(result).toEqual({ recallAtK: 0, mrr: 0, perQuery: [] });
    expect(Number.isFinite(result.recallAtK)).toBe(true);
    expect(Number.isFinite(result.mrr)).toBe(true);
  });

  it("one hit at rank 0 and one miss gives recallAtK 0.5 and mrr 0.5", () => {
    const judgments: RecallJudgment[] = [
      { query: "hit", targetMemoryId: "t1", retrieved: [{ memoryId: "t1", rank: 0 }] },
      { query: "miss", targetMemoryId: "t2", retrieved: [{ memoryId: "other", rank: 0 }] },
    ];
    const result = evaluateRecall(judgments);
    expect(result.recallAtK).toBe(0.5);
    expect(result.mrr).toBe(0.5);
  });

  it("recallAtK is foundCount / judgments.length", () => {
    const judgments: RecallJudgment[] = [
      { query: "a", targetMemoryId: "1", retrieved: [{ memoryId: "1", rank: 0 }] },
      { query: "b", targetMemoryId: "2", retrieved: [{ memoryId: "2", rank: 5 }] },
      { query: "c", targetMemoryId: "3", retrieved: [] },
      { query: "d", targetMemoryId: "4", retrieved: [] },
    ];
    const result = evaluateRecall(judgments);
    expect(result.recallAtK).toBe(0.5); // 2 of 4 found
  });

  it("mrr is the mean of reciprocalRank across all judgments including misses", () => {
    const judgments: RecallJudgment[] = [
      { query: "a", targetMemoryId: "1", retrieved: [{ memoryId: "1", rank: 0 }] }, // rr = 1
      { query: "b", targetMemoryId: "2", retrieved: [{ memoryId: "2", rank: 1 }] }, // rr = 0.5
      { query: "c", targetMemoryId: "3", retrieved: [] }, // rr = 0
    ];
    const result = evaluateRecall(judgments);
    expect(result.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
  });

  it("is pure: calling twice with the same input returns deep-equal results and mutates nothing", () => {
    const judgments: RecallJudgment[] = [
      { query: "a", targetMemoryId: "1", retrieved: [{ memoryId: "1", rank: 0 }] },
      { query: "b", targetMemoryId: "2", retrieved: [{ memoryId: "other", rank: 0 }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(judgments));

    const first = evaluateRecall(judgments);
    const second = evaluateRecall(judgments);

    expect(first).toEqual(second);
    expect(judgments).toEqual(snapshot); // input array/nested arrays untouched
  });
});
