/**
 * Deterministic fusion scoring for hybrid memory retrieval (feature 5).
 *
 * Score = wRecency * recency + wImportance * importance + wRelevance * relevance
 *
 * All math is pure arithmetic — same inputs produce identical scores, bit-for-bit.
 * No I/O, no randomness, no LLM.
 *
 * References:
 *  - Generative Agents (Park et al 2023): recency × importance × relevance
 *  - Feature 5 spec: scoreMemory(), exponential decay half-life 72h
 */

export interface ScoringConfig {
  weights: { recency: number; importance: number; relevance: number };
  relevanceBlend: { vector: number; bm25: number; entity: number };
  recencyHalfLifeHours: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: { recency: 1.0, importance: 1.0, relevance: 1.0 },
  relevanceBlend: { vector: 0.5, bm25: 0.3, entity: 0.2 },
  recencyHalfLifeHours: 72,
};

export interface CandidateForScoring {
  importance: number; // 1..10 (stored salience; default 5)
  lastAccessedAt: number; // Unix epoch ms
  signals: {
    vector?: number; // normalized [0,1]
    bm25?: number; // normalized [0,1]
    entity?: number; // normalized [0,1]
  };
}

/** Clamp to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Exponential recency decay (Generative Agents style).
 * recency = exp(-ln(2) * ageHours / halfLife)
 * Range: (0, 1]. Newer = higher.
 */
export function recencyScore(
  lastAccessedAt: number,
  nowMs: number,
  halfLifeHours: number,
): number {
  const ageMs = Math.max(0, nowMs - lastAccessedAt);
  const ageHours = ageMs / 3_600_000;
  return Math.exp((-Math.LN2 * ageHours) / halfLifeHours);
}

/**
 * Compute blended relevance from normalized retrieval signals.
 * Each signal is already in [0, 1].
 */
export function relevanceScore(
  signals: CandidateForScoring["signals"],
  blend: ScoringConfig["relevanceBlend"],
): number {
  const v = signals.vector ?? 0;
  const b = signals.bm25 ?? 0;
  const e = signals.entity ?? 0;
  return clamp01(blend.vector * v + blend.bm25 * b + blend.entity * e);
}

/**
 * Full fusion score for a memory candidate.
 *
 * Returns the final fused score and per-component breakdown.
 */
export function scoreMemory(
  candidate: CandidateForScoring,
  nowMs: number,
  cfg: ScoringConfig,
): {
  fusedScore: number;
  recency: number;
  importance: number;
  relevance: number;
} {
  const recency = recencyScore(candidate.lastAccessedAt, nowMs, cfg.recencyHalfLifeHours);
  const importance = clamp01((candidate.importance ?? 5) / 10); // [0.1, 1]
  const relevance = relevanceScore(candidate.signals, cfg.relevanceBlend);

  const fusedScore =
    cfg.weights.recency * recency +
    cfg.weights.importance * importance +
    cfg.weights.relevance * relevance;

  return { fusedScore, recency, importance, relevance };
}

/**
 * Normalize a list of raw BM25 scores to [0, 1] via min-max.
 * Guards divide-by-zero: if all scores equal, assign 1.0.
 */
export function normalizeBm25(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  if (max === min) return scores.map(() => 1.0);
  return scores.map((s) => (s - min) / (max - min));
}

/**
 * Normalize cosine similarity (range [-1, 1]) to [0, 1].
 * (cos + 1) / 2
 */
export function normalizeCosine(cosine: number): number {
  return (cosine + 1) / 2;
}
