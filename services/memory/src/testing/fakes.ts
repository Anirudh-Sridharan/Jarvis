/**
 * FakeEmbedder and FakeLlm — deterministic test fakes for @jarvis/memory.
 *
 * These are exported from the `@jarvis/memory/testing` subpath so that:
 *  - Tests in this package can use them.
 *  - @jarvis/core (or integration tests) can import them without a real model server.
 *
 * FakeEmbedder: deterministic hash → 256-dim unit vector. Same text → same vector.
 * FakeLlm: returns canned structured JSON matching expected extraction/reflection shapes.
 */

import { createHash } from "node:crypto";
import type { Clock, Embedder, LlmClient, Reranker } from "../types.js";

const EMBEDDING_DIM = 256;

/**
 * Deterministic hash-based embedder.
 * Produces a stable 256-dim unit vector from the SHA-256 of the input text.
 * Same text → same vector (reproducible across runs).
 */
export class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashToVector(text, EMBEDDING_DIM));
  }
}

function hashToVector(text: string, dim: number): number[] {
  const hash = createHash("sha256").update(text).digest();
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    // Each byte provides 4 bits; fill dim floats from the hash, cycling
    const byteIdx = i % hash.length;
    const byte = hash[byteIdx] ?? 0;
    vec.push((byte / 255) * 2 - 1); // scale to [-1, 1]
  }
  // L2-normalize to unit sphere
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/**
 * FakeLlm: returns canned JSON for known prompt patterns.
 *
 * Extraction: returns a minimal fact array.
 * Reflection: returns a minimal insight array.
 * Importance: returns {"importance": 6}.
 * Procedural: returns a markdown stub.
 * Tie-break: returns {"winner": "incoming", "reason": "newer"}.
 */
export class FakeLlm implements LlmClient {
  /** Optional override: map prompt substrings to canned responses. */
  private overrides: Array<{ match: string; response: string }> = [];

  addOverride(match: string, response: string): void {
    this.overrides.push({ match, response });
  }

  async complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
  }): Promise<string> {
    // Check overrides first
    for (const o of this.overrides) {
      if (opts.prompt.includes(o.match)) {
        return o.response;
      }
    }

    const p = opts.prompt;

    // Fact extraction prompt
    if (p.includes("discrete, updateable FACTS") || p.includes("entity") && p.includes("predicate") && p.includes("confidence")) {
      return JSON.stringify([
        {
          entity: "self",
          predicate: "prefers",
          object: "TypeScript",
          text: "User prefers TypeScript",
          confidence: 0.9,
        },
      ]);
    }

    // Insight / reflection prompt
    if (p.includes("patterns, trends, or insights") || p.includes("meaningful patterns")) {
      return JSON.stringify([
        {
          text: "User frequently mentions work-related topics",
          kind: "pattern",
          importance: 6,
        },
      ]);
    }

    // Importance scoring
    if (p.includes("Rate the long-term importance") || p.includes("scale of 1-10")) {
      return JSON.stringify({ importance: 6 });
    }

    // Procedural block update
    if (p.includes("how I like to work") || p.includes("personal")) {
      return "## How I Like to Work\n\n- Prefer TypeScript over JavaScript.\n- Morning deep work sessions.\n";
    }

    // Tie-break
    if (p.includes("conflicting facts") || p.includes("more likely correct")) {
      return JSON.stringify({ winner: "incoming", reason: "newer information" });
    }

    // Default: empty JSON array (safe fallback)
    return "[]";
  }
}

/**
 * FakeReranker — deterministic second-stage scorer for tests.
 *
 * Default scoring: Jaccard token overlap between query and document (a stand-in
 * for a real cross-encoder's relevance — fully deterministic, same inputs →
 * same scores). Pass a custom `scoreFn` for precise control over ordering in a
 * test, or set `failNext`/`throwAlways` to exercise the graceful-fallback path.
 */
export class FakeReranker implements Reranker {
  private throwAlways = false;
  constructor(
    private readonly scoreFn: (query: string, doc: string) => number = jaccardOverlap,
  ) {}

  /** Make every rerank() call reject — exercises the fallback-to-first-stage path. */
  alwaysThrow(): this {
    this.throwAlways = true;
    return this;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (this.throwAlways) throw new Error("FakeReranker: forced failure");
    return documents.map((doc) => this.scoreFn(query, doc));
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

/** Jaccard similarity of token sets — deterministic, in [0, 1]. */
function jaccardOverlap(query: string, doc: string): number {
  const q = tokenize(query);
  const d = tokenize(doc);
  if (q.size === 0 || d.size === 0) return 0;
  let inter = 0;
  for (const t of q) if (d.has(t)) inter++;
  const union = q.size + d.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * FixedClock — deterministic Clock fake for MEM-02 backoff/retry tests.
 * Mirrors @jarvis/integrations' FixedClock exactly (leaf packages are
 * siblings — this is a local re-declaration, not an import).
 */
export class FixedClock implements Clock {
  constructor(private timestamp: number = Date.now()) {}

  now(): number {
    return this.timestamp;
  }

  advance(ms: number): void {
    this.timestamp += ms;
  }

  setTo(isoOrMs: string | number): void {
    this.timestamp = typeof isoOrMs === "string" ? new Date(isoOrMs).getTime() : isoOrMs;
  }
}
