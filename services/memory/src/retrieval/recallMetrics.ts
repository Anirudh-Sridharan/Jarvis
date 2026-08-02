/**
 * Pure recall@k / Mean Reciprocal Rank (MRR) scoring for retrieval evaluation
 * (MEM-05, phase 13 eval harness).
 *
 * Mirrors scoring.ts's determinism contract exactly: pure arithmetic — same
 * inputs produce identical scores, bit-for-bit. No I/O, no randomness, no LLM.
 *
 * Sibling to services/memory/src/retrieval/scoring.ts — that module scores a
 * single candidate for fusion/ranking; this module scores a whole retrieval
 * RUN (a set of judgments) against ground truth. recall@k and MRR are
 * textbook information-retrieval metrics — no external prior-art citation
 * needed, unlike scoring.ts's Generative Agents reference.
 *
 * This is the ONE shared implementation: both the hermetic vitest harness
 * (services/memory/test/recallEval.test.ts) and the live CLI probe (plan
 * 13-04, @jarvis/core) import this exact function so their numbers are
 * directly comparable and can never drift apart into two implementations.
 */

/** One query's ground truth and the ranked results retrieval actually returned. */
export interface RecallJudgment {
  query: string;
  targetMemoryId: string;
  retrieved: Array<{ memoryId: string; rank: number }>;
}

/** Per-query scoring detail — echoes the judgment's identity plus the outcome. */
export interface PerQueryRecall {
  query: string;
  targetMemoryId: string;
  found: boolean;
  rank: number | null;
  reciprocalRank: number;
}

/** Aggregate recall@k / MRR across all judgments, plus the per-query detail. */
export interface RecallEvalResult {
  recallAtK: number;
  mrr: number;
  perQuery: PerQueryRecall[];
}

/**
 * Score a set of retrieval judgments against ground truth.
 *
 * For each judgment, finds the first `retrieved` entry whose `memoryId`
 * matches `targetMemoryId` and computes its reciprocal rank.
 *
 * `RetrievedMemory.rank` (services/memory/src/types.ts) is 0-INDEXED — rank 0
 * is the top hit (services/memory/src/retrieval/retrieval.ts's
 * `selected.map((c, i) => ({ ..., rank: i }))`). Reciprocal rank must
 * therefore be `1 / (rank + 1)`, never `1 / rank` — the latter divides by
 * zero on the top-ranked hit.
 *
 * Both aggregate divisions are guarded with `|| 1` on the denominator so an
 * empty judgment list returns zeros rather than NaN.
 */
export function evaluateRecall(judgments: RecallJudgment[]): RecallEvalResult {
  const perQuery: PerQueryRecall[] = judgments.map((j) => {
    const hit = j.retrieved.find((r) => r.memoryId === j.targetMemoryId);
    // +1 is load-bearing: rank is 0-indexed, so 1/rank would divide by zero
    // on the top hit (rank 0). See retrieval.ts's `rank: i` assignment.
    const reciprocalRank = hit ? 1 / (hit.rank + 1) : 0;
    return {
      query: j.query,
      targetMemoryId: j.targetMemoryId,
      found: !!hit,
      rank: hit?.rank ?? null,
      reciprocalRank,
    };
  });

  const denom = perQuery.length || 1;
  const recallAtK = perQuery.filter((p) => p.found).length / denom;
  const mrr = perQuery.reduce((sum, p) => sum + p.reciprocalRank, 0) / denom;

  return { recallAtK, mrr, perQuery };
}
