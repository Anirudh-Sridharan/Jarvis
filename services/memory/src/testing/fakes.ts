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
import type { Embedder, LlmClient } from "../types.js";

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
