/**
 * Pure-JS cosine similarity and top-K vector search.
 *
 * This is a brute-force O(n·d) scan — correct at single-user scale (thousands
 * of embeddings, 256 dims). At scale, swap to sqlite-vec or LanceDB.
 *
 * TODO(scale): replace with sqlite-vec ANN or LanceDB when the corpus exceeds
 * ~50k entries or d > 512.
 */

/** Cosine similarity between two equal-length vectors. Range [-1, 1].
 *  Returns 0 on dimension mismatch (instead of silently truncating). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export interface VectorEntry {
  id: string;
  embedding: number[];
}

export interface ScoredEntry {
  id: string;
  score: number; // cosine similarity [-1,1]
}

/**
 * Brute-force top-K cosine search over a flat list of embeddings.
 * Returns entries sorted descending by cosine similarity.
 */
export function topKCosine(
  query: number[],
  entries: VectorEntry[],
  k: number,
): ScoredEntry[] {
  const scored = entries.map((e) => ({
    id: e.id,
    score: cosineSimilarity(query, e.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
