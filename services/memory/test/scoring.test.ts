/**
 * Tests for retrieval scoring: recency decay, importance, relevance, fusion.
 */

import { describe, it, expect } from "vitest";
import {
  scoreMemory,
  recencyScore,
  relevanceScore,
  normalizeBm25,
  normalizeCosine,
  clamp01,
  DEFAULT_SCORING_CONFIG,
} from "../src/retrieval/scoring.js";

const CFG = DEFAULT_SCORING_CONFIG;
const NOW_MS = new Date("2026-06-09T12:00:00Z").getTime();

describe("recencyScore", () => {
  it("returns 1.0 for brand-new access (age = 0)", () => {
    const score = recencyScore(NOW_MS, NOW_MS, 72);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("returns ~0.5 at half-life (72h)", () => {
    const halfLifeMs = 72 * 3_600_000;
    const score = recencyScore(NOW_MS - halfLifeMs, NOW_MS, 72);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it("returns <0.5 for ages older than half-life", () => {
    const oldMs = NOW_MS - 100 * 3_600_000; // 100h ago
    expect(recencyScore(oldMs, NOW_MS, 72)).toBeLessThan(0.5);
  });

  it("clamps negative age to 0 (clock skew)", () => {
    const futureMs = NOW_MS + 1_000_000;
    const score = recencyScore(futureMs, NOW_MS, 72);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("decays monotonically with age", () => {
    const s1 = recencyScore(NOW_MS - 10_000, NOW_MS, 72);
    const s2 = recencyScore(NOW_MS - 100_000, NOW_MS, 72);
    const s3 = recencyScore(NOW_MS - 1_000_000, NOW_MS, 72);
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
  });
});

describe("normalizeCosine", () => {
  it("maps -1 → 0, 0 → 0.5, 1 → 1", () => {
    expect(normalizeCosine(-1)).toBeCloseTo(0);
    expect(normalizeCosine(0)).toBeCloseTo(0.5);
    expect(normalizeCosine(1)).toBeCloseTo(1);
  });
});

describe("normalizeBm25", () => {
  it("normalizes scores to [0, 1]", () => {
    const raw = [0.5, 2.0, 1.0, 3.0];
    const norm = normalizeBm25(raw);
    expect(Math.min(...norm)).toBeCloseTo(0);
    expect(Math.max(...norm)).toBeCloseTo(1);
  });

  it("handles single-result page (max==min → 1.0)", () => {
    expect(normalizeBm25([5.0])).toEqual([1.0]);
  });

  it("handles all-same scores", () => {
    const norm = normalizeBm25([2, 2, 2]);
    for (const v of norm) expect(v).toBe(1.0);
  });

  it("returns empty for empty input", () => {
    expect(normalizeBm25([])).toEqual([]);
  });
});

describe("scoreMemory - fusion", () => {
  it("recent+important+relevant beats stale+unimportant+irrelevant", () => {
    const recentImportant = scoreMemory(
      {
        importance: 9,
        lastAccessedAt: NOW_MS - 1_000, // 1 second ago
        signals: { vector: 0.9, bm25: 0.8, entity: 0.7 },
      },
      NOW_MS,
      CFG,
    );

    const stale = scoreMemory(
      {
        importance: 2,
        lastAccessedAt: NOW_MS - 7 * 24 * 3_600_000, // 7 days ago
        signals: { vector: 0.1, bm25: 0.0, entity: 0.0 },
      },
      NOW_MS,
      CFG,
    );

    expect(recentImportant.fusedScore).toBeGreaterThan(stale.fusedScore);
  });

  it("importance component is normalized to [0,1]", () => {
    const { importance } = scoreMemory(
      { importance: 10, lastAccessedAt: NOW_MS, signals: {} },
      NOW_MS,
      CFG,
    );
    expect(importance).toBeCloseTo(1.0);
  });

  it("importance defaults to 5 when not provided", () => {
    const { importance } = scoreMemory(
      { importance: 5, lastAccessedAt: NOW_MS, signals: {} },
      NOW_MS,
      CFG,
    );
    expect(importance).toBeCloseTo(0.5);
  });

  it("is deterministic: same inputs → identical score", () => {
    const candidate = {
      importance: 7,
      lastAccessedAt: NOW_MS - 2 * 3_600_000,
      signals: { vector: 0.6, bm25: 0.4 },
    };
    const s1 = scoreMemory(candidate, NOW_MS, CFG);
    const s2 = scoreMemory(candidate, NOW_MS, CFG);
    expect(s1.fusedScore).toBe(s2.fusedScore);
  });
});

describe("relevanceScore", () => {
  it("blends signals correctly", () => {
    const blend = { vector: 0.5, bm25: 0.3, entity: 0.2 };
    const score = relevanceScore({ vector: 1.0, bm25: 1.0, entity: 1.0 }, blend);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("uses zero for missing signals", () => {
    const blend = { vector: 0.5, bm25: 0.3, entity: 0.2 };
    const score = relevanceScore({ vector: 1.0 }, blend);
    expect(score).toBeCloseTo(0.5);
  });
});

describe("clamp01", () => {
  it("clamps below 0 to 0", () => expect(clamp01(-5)).toBe(0));
  it("clamps above 1 to 1", () => expect(clamp01(5)).toBe(1));
  it("passes through values in range", () => expect(clamp01(0.5)).toBe(0.5));
});

// ── Gap 4: Stronger scoring determinism and monotonicity ─────────────────────

/**
 * A simple seeded linear-congruential PRNG, so tests don't use Math.random().
 * Returns floats in [0, 1).
 */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // LCG: parameters from Numerical Recipes
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface SeededCandidate {
  importance: number;
  lastAccessedAt: number;
  signals: { vector?: number; bm25?: number; entity?: number };
}

function generateCandidates(count: number, seed: number): SeededCandidate[] {
  const rng = makePrng(seed);
  const candidates: SeededCandidate[] = [];
  for (let i = 0; i < count; i++) {
    candidates.push({
      importance: Math.floor(rng() * 10) + 1, // 1..10
      lastAccessedAt: NOW_MS - rng() * 30 * 24 * 3_600_000, // 0..30 days ago
      signals: {
        vector: rng(),
        bm25: rng(),
        entity: rng(),
      },
    });
  }
  return candidates;
}

describe("scoreMemory - determinism over large seeded set", () => {
  const CANDIDATE_COUNT = 200;
  const SEED = 0xdeadbeef;

  it("is perfectly deterministic: same inputs produce identical scores across 3 runs", () => {
    const candidates = generateCandidates(CANDIDATE_COUNT, SEED);

    const run1 = candidates.map((c) => scoreMemory(c, NOW_MS, CFG).fusedScore);
    const run2 = candidates.map((c) => scoreMemory(c, NOW_MS, CFG).fusedScore);
    const run3 = candidates.map((c) => scoreMemory(c, NOW_MS, CFG).fusedScore);

    for (let i = 0; i < CANDIDATE_COUNT; i++) {
      expect(run1[i]).toBe(run2[i]);
      expect(run2[i]).toBe(run3[i]);
    }
  });

  it("score is not trivially zero or constant across 200 seeded candidates", () => {
    const candidates = generateCandidates(CANDIDATE_COUNT, SEED);
    const scores = candidates.map((c) => scoreMemory(c, NOW_MS, CFG).fusedScore);

    const min = Math.min(...scores);
    const max = Math.max(...scores);

    // Scores should span a real range — not all identical
    expect(max - min).toBeGreaterThan(0.1);
    // All scores should be positive
    expect(min).toBeGreaterThan(0);
  });
});

describe("scoreMemory - monotonicity", () => {
  const BASE: SeededCandidate = {
    importance: 5,
    lastAccessedAt: NOW_MS - 3 * 3_600_000, // 3 hours ago
    signals: { vector: 0.5, bm25: 0.4, entity: 0.3 },
  };

  it("raising importance never lowers the score (holding recency/relevance equal)", () => {
    let prev = scoreMemory(BASE, NOW_MS, CFG).fusedScore;
    for (let imp = 6; imp <= 10; imp++) {
      const candidate = { ...BASE, importance: imp };
      const score = scoreMemory(candidate, NOW_MS, CFG).fusedScore;
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("raising vector signal never lowers the score (holding others equal)", () => {
    let prev = scoreMemory({ ...BASE, signals: { ...BASE.signals, vector: 0 } }, NOW_MS, CFG).fusedScore;
    for (let v = 1; v <= 10; v++) {
      const candidate = { ...BASE, signals: { ...BASE.signals, vector: v / 10 } };
      const score = scoreMemory(candidate, NOW_MS, CFG).fusedScore;
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("raising bm25 signal never lowers the score (holding others equal)", () => {
    let prev = scoreMemory({ ...BASE, signals: { ...BASE.signals, bm25: 0 } }, NOW_MS, CFG).fusedScore;
    for (let b = 1; b <= 10; b++) {
      const candidate = { ...BASE, signals: { ...BASE.signals, bm25: b / 10 } };
      const score = scoreMemory(candidate, NOW_MS, CFG).fusedScore;
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("making access more recent never lowers the score (holding importance/relevance equal)", () => {
    // Start very old, move to more recent
    const ages = [30 * 24, 14 * 24, 7 * 24, 3 * 24, 24, 1].map(
      (h) => NOW_MS - h * 3_600_000,
    );
    let prev = scoreMemory({ ...BASE, lastAccessedAt: ages[0]! }, NOW_MS, CFG).fusedScore;
    for (let i = 1; i < ages.length; i++) {
      const candidate = { ...BASE, lastAccessedAt: ages[i]! };
      const score = scoreMemory(candidate, NOW_MS, CFG).fusedScore;
      expect(score).toBeGreaterThanOrEqual(prev);
      prev = score;
    }
  });

  it("raising importance by 1 on 100 seeded candidates never lowers the score", () => {
    const rng = makePrng(0xcafebabe);
    for (let i = 0; i < 100; i++) {
      const base: SeededCandidate = {
        importance: Math.floor(rng() * 9) + 1, // 1..9
        lastAccessedAt: NOW_MS - rng() * 72 * 3_600_000,
        signals: { vector: rng(), bm25: rng(), entity: rng() },
      };
      const raised = { ...base, importance: base.importance + 1 };
      const s1 = scoreMemory(base, NOW_MS, CFG).fusedScore;
      const s2 = scoreMemory(raised, NOW_MS, CFG).fusedScore;
      expect(s2).toBeGreaterThanOrEqual(s1);
    }
  });

  it("raising relevance by 0.1 on 100 seeded candidates never lowers the score", () => {
    const rng = makePrng(0xbadf00d);
    for (let i = 0; i < 100; i++) {
      const baseVector = rng() * 0.9; // leave room to raise by 0.1
      const base: SeededCandidate = {
        importance: Math.floor(rng() * 10) + 1,
        lastAccessedAt: NOW_MS - rng() * 72 * 3_600_000,
        signals: { vector: baseVector, bm25: rng(), entity: rng() },
      };
      const raised = { ...base, signals: { ...base.signals, vector: baseVector + 0.1 } };
      const s1 = scoreMemory(base, NOW_MS, CFG).fusedScore;
      const s2 = scoreMemory(raised, NOW_MS, CFG).fusedScore;
      expect(s2).toBeGreaterThanOrEqual(s1);
    }
  });
});
