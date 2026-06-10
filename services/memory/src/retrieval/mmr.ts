/**
 * Maximal Marginal Relevance (MMR) selection.
 *
 * Greedy algorithm: iteratively picks the candidate that maximises
 *   mmrScore = λ * sim(candidate, query) - (1 - λ) * max_sim(candidate, selected)
 *
 * This de-duplicates near-identical candidates: once a very similar item is
 * selected, the second item's maxSim penalty is high, pushing it out of
 * the top-K.
 *
 * Reference: Carbonell & Goldstein (1998) "The use of MMR, diversity-based
 * reranking for reordering documents and producing summaries."
 */

import { cosineSimilarity } from "../search/cosine.js";

export interface MmrCandidate {
  /** Cosine similarity between the candidate embedding and the query embedding.
   *  May be precomputed or computed on the fly by this function. */
  queryScore: number; // relevance to query, already in [-1, 1] or [0, 1]
  embedding?: number[];
}

export interface MmrOptions {
  /** Trade-off: 1.0 = pure relevance ordering, 0.0 = pure diversity. */
  lambda?: number;
  /** Maximum number of items to select. */
  k: number;
}

/**
 * Pure MMR selection over an array of typed candidates.
 *
 * @param candidates  Ordered list of candidates (arbitrary type T that extends MmrCandidate).
 * @param queryVec    Raw query embedding vector.
 * @param opts        { lambda, k }
 * @returns           Selected subset of candidates in MMR order (at most k items).
 */
export function mmrSelect<T extends MmrCandidate>(
  candidates: T[],
  queryVec: number[],
  opts: MmrOptions,
): T[] {
  const lambda = opts.lambda ?? 0.7;
  const k = opts.k;

  if (candidates.length === 0) return [];
  if (k <= 0) return [];

  const selected: T[] = [];
  const remaining = candidates.map((c, i) => ({ c, i }));

  while (selected.length < k && remaining.length > 0) {
    let bestScore = -Infinity;
    let bestPos = 0;

    for (let pos = 0; pos < remaining.length; pos++) {
      const { c } = remaining[pos]!;

      // Relevance to query: use cosine against queryVec if embedding available,
      // otherwise fall back to the precomputed queryScore.
      const relevance =
        c.embedding && queryVec.length > 0
          ? (cosineSimilarity(queryVec, c.embedding) + 1) / 2
          : c.queryScore;

      // Max similarity to already-selected items.
      let maxSim = 0;
      if (selected.length > 0) {
        for (const s of selected) {
          if (s.embedding && c.embedding) {
            const sim = (cosineSimilarity(c.embedding, s.embedding) + 1) / 2;
            if (sim > maxSim) maxSim = sim;
          }
          // If no embeddings available, use queryScore as a proxy — items
          // with the same relevance score are treated as similar.
          else if (!s.embedding && !c.embedding) {
            const proxy = 1 - Math.abs(c.queryScore - s.queryScore);
            if (proxy > maxSim) maxSim = proxy;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestPos = pos;
      }
    }

    selected.push(remaining[bestPos]!.c);
    remaining.splice(bestPos, 1);
  }

  return selected;
}
