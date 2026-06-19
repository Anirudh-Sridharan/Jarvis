/**
 * Hybrid memory retrieval (feature 5).
 *
 * Runs three retrievers (vector, BM25, entity) in parallel, fuses candidates
 * with deterministic scoring (recency × importance × relevance), applies MMR
 * de-dup, and returns top-K with placement hints.
 *
 * The entire scoring path is deterministic given the store snapshot and `now`.
 * No LLM is in the hot path.
 */

import type { RetrievedMemory, RetrievalOptions, Embedder, Reranker, MemoryNode } from "../types.js";
import type { MemoryStore } from "../store/memoryStore.js";
import {
  scoreMemory,
  normalizeBm25,
  normalizeCosine,
  DEFAULT_SCORING_CONFIG,
  type ScoringConfig,
} from "./scoring.js";
import { mmrSelect } from "./mmr.js";

const DEFAULT_K = 8;
const DEFAULT_MIN_RELEVANCE = 0.05;
const MMR_LAMBDA = 0.7;
const CANDIDATE_CAP_VECTOR = 50;
const CANDIDATE_CAP_BM25 = 50;
const CANDIDATE_CAP_ENTITY = 30;
const TOTAL_CAP = 80;
const RERANK_CAP = 20;

interface InternalCandidate {
  memoryId: string;
  text: string;
  kind: "episode" | "entity" | "fact";
  importance: number;
  lastAccessedAt: number;
  validFrom: string;
  embedding?: number[];
  /** queryScore satisfies MmrCandidate contract: cosine-normalized similarity to query */
  queryScore: number;
  signals: { vector?: number; bm25?: number; entity?: number };
  rawSignals: { vecCosine?: number; bm25Raw?: number; entityHits?: number };
  relevance?: number;
  fusedScore?: number;
  rerankerScore?: number;
  scoreBreakdown?: {
    recency: number;
    importance: number;
    relevance: number;
  };
}

export class RetrievalService {
  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
    private readonly cfg: ScoringConfig = DEFAULT_SCORING_CONFIG,
    /** Optional second-stage reranker. When absent, retrieval is unchanged. */
    private readonly reranker?: Reranker,
  ) {}

  /** Get the current procedural block markdown (or empty string). */
  getProceduralBlock(): string {
    const block = this.store.getProceduralBlock();
    return block?.markdown ?? "";
  }

  /**
   * Retrieve top-K memories for a query.
   * Runs vector + BM25 + entity retrievers in parallel, fuses scores, applies MMR.
   */
  async retrieve(
    query: string,
    opts: RetrievalOptions = {},
  ): Promise<RetrievedMemory[]> {
    const k = opts.k ?? DEFAULT_K;
    const nowMs = opts.now ?? Date.now();
    const minRelevance = opts.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    const includeStale = opts.includeStale ?? false;

    if (!query.trim()) return [];

    // 1. Embed query. If the embedder is unavailable or returns no vector,
    // degrade gracefully: skip the vector retriever but still run the
    // keyword/entity paths (feature-5 edge case 8: embedder down → BM25 + entity).
    let queryVec: number[] | undefined;
    try {
      [queryVec] = await this.embedder.embed([query]);
    } catch {
      queryVec = undefined;
    }

    // 2. Fan out three retrievers in parallel
    const [vectorResults, bm25Results, entityResults] = await Promise.all([
      queryVec
        ? this.vectorRetriever(queryVec, CANDIDATE_CAP_VECTOR, includeStale, nowMs)
        : ([] as InternalCandidate[]),
      this.bm25Retriever(query, CANDIDATE_CAP_BM25),
      this.entityRetriever(opts.entityIds ?? [], CANDIDATE_CAP_ENTITY),
    ]);

    // 3. Merge candidate pools
    const candidateMap = new Map<string, InternalCandidate>();

    for (const r of vectorResults) {
      candidateMap.set(r.memoryId, {
        ...r,
        queryScore: r.rawSignals.vecCosine !== undefined ? normalizeCosine(r.rawSignals.vecCosine) : 0,
        rawSignals: { vecCosine: r.rawSignals.vecCosine },
        signals: {},
      });
    }
    for (const r of bm25Results) {
      const existing = candidateMap.get(r.memoryId);
      if (existing) {
        existing.rawSignals.bm25Raw = r.rawSignals.bm25Raw;
      } else {
        candidateMap.set(r.memoryId, { ...r, queryScore: 0, signals: {} });
      }
    }
    for (const r of entityResults) {
      const existing = candidateMap.get(r.memoryId);
      if (existing) {
        existing.rawSignals.entityHits = (existing.rawSignals.entityHits ?? 0) + 1;
      } else {
        candidateMap.set(r.memoryId, { ...r, queryScore: 0, signals: {} });
      }
    }

    // Cap total candidates
    let candidates = Array.from(candidateMap.values());
    if (candidates.length > TOTAL_CAP) {
      candidates = candidates.slice(0, TOTAL_CAP);
    }

    if (candidates.length === 0) return [];

    // 4. Normalize signals to [0, 1]
    // Vector: (cos+1)/2
    for (const c of candidates) {
      if (c.rawSignals.vecCosine !== undefined) {
        c.signals.vector = normalizeCosine(c.rawSignals.vecCosine);
      }
    }

    // BM25: min-max over the page
    const bm25Scores = candidates.map((c) => c.rawSignals.bm25Raw ?? 0);
    const bm25Norm = normalizeBm25(bm25Scores);
    candidates.forEach((c, i) => {
      if (c.rawSignals.bm25Raw !== undefined) {
        c.signals.bm25 = bm25Norm[i] ?? 0;
      }
    });

    // Entity: hits / max_hits (capped at 1)
    const maxEntityHits = Math.max(
      1,
      ...candidates.map((c) => c.rawSignals.entityHits ?? 0),
    );
    for (const c of candidates) {
      if (c.rawSignals.entityHits) {
        c.signals.entity = Math.min(c.rawSignals.entityHits / maxEntityHits, 1);
      }
    }

    // 5. Score candidates
    for (const c of candidates) {
      const scored = scoreMemory(
        { importance: c.importance, lastAccessedAt: c.lastAccessedAt, signals: c.signals },
        nowMs,
        this.cfg,
      );
      c.fusedScore = scored.fusedScore;
      c.relevance = scored.relevance;
      c.scoreBreakdown = {
        recency: scored.recency,
        importance: scored.importance,
        relevance: scored.relevance,
      };
      // Keep queryScore in sync: prefer vector signal if available
      if (c.signals.vector !== undefined) {
        c.queryScore = c.signals.vector;
      } else if (c.queryScore === 0) {
        c.queryScore = scored.relevance;
      }
    }

    // 6. Apply relevance floor
    const kept = candidates.filter((c) => (c.relevance ?? 0) >= minRelevance);
    if (kept.length === 0) return [];

    // 7. Sort and cap pre-MMR
    kept.sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0));
    const preMMR = kept.slice(0, RERANK_CAP);

    // 7b. Optional second-stage rerank of the top candidates. A cross-encoder
    // scores query↔doc jointly — sharper relevance than the first-stage blend —
    // and folds into the relevance slot of the fused score (recency/importance
    // are preserved). No-op + graceful fallback when no reranker is configured.
    const reranked = await this.applyReranker(query, preMMR);

    // 8. MMR de-dup — greedy Maximal Marginal Relevance.
    // When reranked, pass an empty queryVec so MMR's relevance term reads each
    // candidate's queryScore (now the reranker score); candidate-candidate
    // diversity still uses embeddings. Otherwise use the query embedding.
    const selected = mmrSelect(
      reranked.candidates,
      reranked.applied ? [] : (queryVec ?? []),
      { lambda: MMR_LAMBDA, k },
    );

    // 9. Build results with placement hints
    const results: RetrievedMemory[] = selected.map((c, i) => ({
      memoryId: c.memoryId,
      text: c.text,
      kind: c.kind,
      fusedScore: c.fusedScore ?? 0,
      scoreBreakdown: {
        recency: c.scoreBreakdown?.recency ?? 0,
        importance: c.scoreBreakdown?.importance ?? 0,
        relevance: c.scoreBreakdown?.relevance ?? 0,
        signals: {
          vector: c.signals.vector ?? 0,
          bm25: c.signals.bm25 ?? 0,
          entity: c.signals.entity ?? 0,
        },
        ...(c.rerankerScore !== undefined ? { rerankerScore: c.rerankerScore } : {}),
      },
      placementHint: placementHint(i),
      validFrom: new Date(c.validFrom).getTime(),
      rank: i,
    }));

    // 10. Touch access counters for the returned memories (fire-and-forget:
    // results are already computed, so this cannot affect determinism).
    try {
      this.store.touchAccess(results.map((r) => r.memoryId));
    } catch {
      // Non-fatal — access tracking must never break retrieval.
    }

    return results;
  }

  /**
   * Second-stage rerank: re-score the top candidates with the injected reranker
   * and fold the result into the relevance slot of the fused score.
   *
   * Fails safe — if no reranker is configured, it throws, or it returns the
   * wrong number of scores, the candidates are returned untouched and
   * `applied=false`, so retrieval degrades exactly to first-stage behavior.
   */
  private async applyReranker(
    query: string,
    candidates: InternalCandidate[],
  ): Promise<{ candidates: InternalCandidate[]; applied: boolean }> {
    if (!this.reranker || candidates.length === 0) {
      return { candidates, applied: false };
    }

    let scores: number[];
    try {
      scores = await this.reranker.rerank(query, candidates.map((c) => c.text));
    } catch {
      return { candidates, applied: false }; // reranker unavailable → keep order
    }
    // Contract guard: one score per document, else ignore the whole result.
    if (!Array.isArray(scores) || scores.length !== candidates.length) {
      return { candidates, applied: false };
    }

    // Min-max normalize the reranker scores to [0, 1] (all-equal → 1.0).
    const norm = normalizeBm25(scores);
    candidates.forEach((c, i) => {
      const r = norm[i] ?? 0;
      c.rerankerScore = r;
      const recency = c.scoreBreakdown?.recency ?? 0;
      const importance = c.scoreBreakdown?.importance ?? 0;
      // Swap the reranker score into the relevance term; keep recency/importance.
      c.fusedScore =
        this.cfg.weights.recency * recency +
        this.cfg.weights.importance * importance +
        this.cfg.weights.relevance * r;
      // MMR reads queryScore as its relevance term — point it at the reranker.
      c.queryScore = r;
    });

    candidates.sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0));
    return { candidates, applied: true };
  }

  // ── Private retrievers ────────────────────────────────────────────────────

  private vectorRetriever(
    queryVec: number[],
    cap: number,
    includeStale: boolean,
    nowMs: number,
  ): InternalCandidate[] {
    const results = this.store.vectorSearch({
      query: queryVec,
      k: cap,
      includeInvalidated: includeStale,
    });
    return results.map((r) => nodeToCandidate(r.node, { vecCosine: r.score }));
  }

  private bm25Retriever(query: string, cap: number): InternalCandidate[] {
    const results = this.store.keywordSearch({ query, k: cap });
    return results.map((r) => nodeToCandidate(r.node, { bm25Raw: r.score }));
  }

  private entityRetriever(entityIds: string[], cap: number): InternalCandidate[] {
    if (entityIds.length === 0) return [];
    const results = this.store.entitySearch({ entityIds, k: cap });
    return results.map((r) => nodeToCandidate(r.node, { entityHits: 1 }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nodeToCandidate(
  node: MemoryNode,
  rawSignals: InternalCandidate["rawSignals"],
): InternalCandidate {
  const validFrom =
    node.kind === "fact"
      ? (node as import("../types.js").Fact).validFrom
      : node.kind === "episode"
        ? (node as import("../types.js").Episode).occurredAt
        : node.ingestedAt;

  const queryScore =
    rawSignals.vecCosine !== undefined
      ? (rawSignals.vecCosine + 1) / 2
      : 0;

  return {
    memoryId: node.id,
    text: node.text,
    kind: node.kind as "episode" | "entity" | "fact",
    importance: node.importance,
    lastAccessedAt: node.lastAccessedAt,
    validFrom,
    embedding: node.embedding,
    queryScore,
    signals: {},
    rawSignals,
  };
}

function placementHint(rank: number): "edge_top" | "edge_bottom" | "middle" {
  if (rank === 0) return "edge_top";
  if (rank === 1) return "edge_bottom";
  return "middle";
}
