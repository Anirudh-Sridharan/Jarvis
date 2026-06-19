/**
 * GatewayReranker — implements @jarvis/memory's Reranker interface as a
 * second-stage relevance scorer backed by the InferenceGateway.
 *
 * It scores all candidate documents in a SINGLE batched chat call (taskHint
 * "chat" → the fast local model) and parses a JSON array of per-document
 * relevance scores. The memory-layer retrieval folds these into the relevance
 * slot of its fused score.
 *
 * Failures (timeout, inference error, unparseable output) throw, so the
 * retrieval layer catches and falls back to first-stage ordering — reranking is
 * a quality boost, never a hard dependency.
 *
 * NOTE: a dedicated cross-encoder (e.g. Qwen3-Reranker-0.6B served by the MLX
 * sidecar via the existing "rerank" task route) is the eventual fast-path swap;
 * this LLM-backed implementation is the live version that needs no new model
 * serving. See architecture/model-serving.md.
 */

import type { Reranker } from "@jarvis/memory";
import type { InferenceGateway } from "../inference/gateway.js";

/** Keep reranking off the critical path: a hung call must not wedge retrieval. */
const DEFAULT_TIMEOUT_MS = 12_000;
/** Trim each doc so a page of 20 candidates stays well within the local ctx. */
const MAX_DOC_CHARS = 280;

export class GatewayReranker implements Reranker {
  constructor(
    // Pick<> rather than the concrete class so tests can pass a tiny fake.
    private readonly gateway: Pick<InferenceGateway, "chat">,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];

    const numbered = documents
      .map((d, i) => `[${i}] ${d.replace(/\s+/g, " ").trim().slice(0, MAX_DOC_CHARS)}`)
      .join("\n");

    const prompt =
      `Rate how relevant each document is to the query on a 0-10 scale ` +
      `(10 = directly relevant, 0 = unrelated).\n` +
      `Query: "${query}"\n\n` +
      `Documents:\n${numbered}\n\n` +
      `Reply with ONLY a JSON array of objects {"i": <document index>, "score": <number 0-10>}, ` +
      `one entry per document.`;

    let raw = "";
    for await (const chunk of this.gateway.chat(
      {
        messages: [{ role: "user", content: prompt }],
        stream: true,
        taskHint: "chat",
      },
      AbortSignal.timeout(this.timeoutMs),
    )) {
      if (chunk.type === "token") raw += chunk.text;
      else if (chunk.type === "error") {
        throw new Error(`GatewayReranker: inference error: ${chunk.message}`);
      }
    }

    return parseScores(raw, documents.length);
  }
}

/**
 * Parse `[{"i":0,"score":7}, ...]` into a dense score array of length `n`.
 * Documents the model omitted default to 0; throws on total parse failure so
 * the caller can fall back to first-stage ordering.
 */
export function parseScores(raw: string, n: number): number[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("GatewayReranker: no JSON array in response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("GatewayReranker: response was not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("GatewayReranker: response was not a non-empty array");
  }

  const scores = new Array<number>(n).fill(0);
  let any = false;
  for (const item of parsed) {
    if (item && typeof item === "object") {
      const i = Number((item as { i?: unknown }).i);
      const s = Number((item as { score?: unknown }).score);
      if (Number.isInteger(i) && i >= 0 && i < n && Number.isFinite(s)) {
        scores[i] = s;
        any = true;
      }
    }
  }
  if (!any) throw new Error("GatewayReranker: no usable scores in response");
  return scores;
}
