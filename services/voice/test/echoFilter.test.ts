/**
 * echoFilter.test.ts — token-containment echo detection.
 *
 * The live mic has no AEC, so Whisper can transcribe Jarvis's own speaker
 * audio. isLikelyEcho decides whether a transcript is such an echo.
 */
import { describe, it, expect } from "vitest";
import { speechTokens, isLikelyEcho } from "../src/echoFilter.js";

describe("speechTokens", () => {
  it("lowercases, strips punctuation, splits on whitespace", () => {
    expect(speechTokens("Hello, World! It's 9 a.m.")).toEqual([
      "hello", "world", "it", "s", "9", "a", "m",
    ]);
  });

  it("returns empty array for empty/punctuation-only input", () => {
    expect(speechTokens("")).toEqual([]);
    expect(speechTokens("...!?")).toEqual([]);
  });
});

describe("isLikelyEcho", () => {
  const reply =
    "The weather today is sunny with a high of 22 degrees. Enjoy your day!";

  it("detects a verbatim echo", () => {
    expect(isLikelyEcho("The weather today is sunny", reply)).toBe(true);
  });

  it("detects a slightly mangled Whisper echo", () => {
    // Whisper drops/merges small words but most tokens match.
    expect(
      isLikelyEcho("weather today is sunny with a high of 22 degrees", reply),
    ).toBe(true);
  });

  it("rejects unrelated user speech", () => {
    expect(isLikelyEcho("set a timer for ten minutes", reply)).toBe(false);
  });

  it("rejects speech with only partial overlap below threshold", () => {
    // Few tokens match the reply (well under the 0.8 containment threshold).
    expect(
      isLikelyEcho("is the weather different in London right now", reply),
    ).toBe(false);
  });

  it("returns false for an empty candidate", () => {
    expect(isLikelyEcho("", reply)).toBe(false);
  });

  it("respects multiset counts (repeated words must exist repeatedly)", () => {
    // "day day day day day" — source has "day" only once → 1/5 matched.
    expect(isLikelyEcho("day day day day day", reply)).toBe(false);
  });
});
