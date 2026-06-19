/**
 * Tests for GatewayReranker — the LLM-backed second-stage reranker adapter.
 *
 * Uses a tiny fake gateway that yields a canned token stream, so we verify the
 * prompt/score round-trip and the parse/fallback contract without a model.
 */

import { describe, it, expect } from "vitest";
import { GatewayReranker, parseScores } from "../src/memory/gatewayReranker.js";
import type { InferenceStreamChunk } from "../src/inference/types.js";

/** A fake gateway whose chat() streams the given string as one token. */
function fakeGateway(response: string | (() => never)): Pick<import("../src/inference/gateway.js").InferenceGateway, "chat"> {
  return {
    async *chat(): AsyncGenerator<InferenceStreamChunk, void, unknown> {
      if (typeof response === "function") response();
      yield { type: "token", text: response };
      yield { type: "done" };
    },
  };
}

describe("GatewayReranker", () => {
  it("returns one score per document, mapped by index", async () => {
    const rr = new GatewayReranker(
      fakeGateway(`[{"i":0,"score":2},{"i":1,"score":9},{"i":2,"score":5}]`),
    );
    const scores = await rr.rerank("query", ["doc a", "doc b", "doc c"]);
    expect(scores).toEqual([2, 9, 5]);
  });

  it("defaults documents the model omitted to 0 (still length-correct)", async () => {
    const rr = new GatewayReranker(fakeGateway(`[{"i":1,"score":7}]`));
    const scores = await rr.rerank("query", ["a", "b", "c"]);
    expect(scores).toEqual([0, 7, 0]);
  });

  it("returns [] for no documents without calling the model", async () => {
    const rr = new GatewayReranker(
      fakeGateway(() => {
        throw new Error("should not be called");
      }),
    );
    expect(await rr.rerank("query", [])).toEqual([]);
  });

  it("throws on unparseable output so retrieval can fall back", async () => {
    const rr = new GatewayReranker(fakeGateway("sorry, I cannot do that"));
    await expect(rr.rerank("query", ["a", "b"])).rejects.toThrow();
  });

  it("propagates inference errors", async () => {
    const erroring: Pick<import("../src/inference/gateway.js").InferenceGateway, "chat"> = {
      async *chat(): AsyncGenerator<InferenceStreamChunk, void, unknown> {
        yield { type: "error", message: "model down" };
      },
    };
    const rr = new GatewayReranker(erroring);
    await expect(rr.rerank("query", ["a"])).rejects.toThrow(/model down/);
  });
});

describe("parseScores", () => {
  it("ignores out-of-range indices and non-finite scores", () => {
    const scores = parseScores(`[{"i":0,"score":3},{"i":9,"score":8},{"i":1,"score":"x"}]`, 2);
    expect(scores).toEqual([3, 0]);
  });

  it("throws when the array has no usable entries", () => {
    expect(() => parseScores(`[{"foo":1}]`, 3)).toThrow();
  });
});
