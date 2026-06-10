/**
 * Token estimator tests — real BPE (cl100k proxy for Qwen), not chars/4.
 */

import { describe, it, expect } from "vitest";
import { estimateTokens, estimateRequestTokens } from "../src/inference/tokens.js";

describe("estimateTokens (BPE)", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("tokenizes common English at BPE granularity, not chars/4", () => {
    // cl100k: "hello" + " world" = 2 tokens; chars/4 would say 3
    expect(estimateTokens("hello world")).toBe(2);
  });

  it("counts a long repeated word ~1 token per word (chars/4 would say ~2.5x)", () => {
    const text = Array(100).fill("information").join(" ");
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(100);
    expect(tokens).toBeLessThan(220); // chars/4 estimate would be ~300
  });

  it("handles non-ASCII without throwing", () => {
    expect(estimateTokens("你好，世界 — Café ☕")).toBeGreaterThan(0);
  });
});

describe("estimateRequestTokens", () => {
  it("sums message content plus per-message framing overhead", () => {
    const messages = [
      { role: "system" as const, content: "hello world" },
      { role: "user" as const, content: "hello world" },
    ];
    // 2 tokens each + 4 framing each
    expect(estimateRequestTokens(messages)).toBe(12);
  });

  it("includes serialized tools when present", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const withTools = estimateRequestTokens(messages, [
      { type: "function", function: { name: "t", description: "d", parameters: {} } },
    ] as never);
    expect(withTools).toBeGreaterThan(estimateRequestTokens(messages));
  });
});
