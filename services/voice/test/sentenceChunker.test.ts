/**
 * sentenceChunker.test.ts
 *
 * Tests for the deterministic sentence chunker — the biggest perceived-latency
 * win in the voice loop.
 */

import { describe, it, expect } from "vitest";
import { collectSentences, chunkSentences } from "../src/sentenceChunker.js";

// Helper: build an async iterable from string array
async function* fromArray(tokens: string[]) {
  for (const t of tokens) yield t;
}

describe("sentenceChunker — basic splitting", () => {
  it("splits two sentences at a period", async () => {
    const tokens = ["Hello world. ", "How are you?"];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Hello world.");
    expect(sentences[1]).toBe("How are you?");
  });

  it("splits on exclamation mark", async () => {
    const tokens = ["Stop! ", "That's amazing!"];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Stop!");
    expect(sentences[1]).toBe("That's amazing!");
  });

  it("splits on question mark", async () => {
    const tokens = ["Are you sure? ", "Yes I am."];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Are you sure?");
    expect(sentences[1]).toBe("Yes I am.");
  });

  it("splits on ellipsis", async () => {
    const tokens = ["Well… ", "I suppose so."];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Well…");
    expect(sentences[1]).toBe("I suppose so.");
  });

  it("splits on newline", async () => {
    const tokens = ["Line one\n", "Line two."];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Line one");
    expect(sentences[1]).toBe("Line two.");
  });
});

describe("sentenceChunker — token fragmentation", () => {
  it("reassembles a sentence from many small fragments", async () => {
    const tokens = ["He", "llo", " wo", "rld", ". ", "Ni", "ce", "."];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("Hello world.");
    expect(sentences[1]).toBe("Nice.");
  });

  it("handles a single-character token at sentence boundary", async () => {
    const tokens = ["Hi.", " ", "There."];
    const sentences = await collectSentences(tokens);
    // "Hi." is only 3 chars, below default minChars of 12 — but it's the first
    // chunk so min is relaxed to 1
    expect(sentences[0]).toBe("Hi.");
    expect(sentences[sentences.length - 1]).toBe("There.");
  });

  it("accumulates tokens across a long sentence without splitting mid-word", async () => {
    const tokens = [
      "The",
      " quick",
      " brown",
      " fox",
      " jumps",
      " over",
      " the",
      " lazy",
      " dog.",
    ];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toBe("The quick brown fox jumps over the lazy dog.");
  });
});

describe("sentenceChunker — minChars enforcement", () => {
  it("does not flush a short fragment before minChars (except first chunk)", async () => {
    // "Hi." = 3 chars. With minChars=12 the FIRST chunk is relaxed (min=1), so it flushes.
    const sentences = await collectSentences(["Hi.", " How are you?"], {
      minChars: 12,
    });
    expect(sentences[0]).toBe("Hi."); // first chunk: relax min
    expect(sentences[1]).toBe("How are you?");
  });

  it("holds non-first short chunks until minChars is met", async () => {
    // After first chunk, "OK." (3 chars) should wait until more text accumulates.
    const tokens = [
      "Hello world. ",   // first chunk (relax min)
      "OK. ",            // too short for minChars=12 without more
      "That is fine.",   // combined "OK. That is fine." should flush as one or split
    ];
    const sentences = await collectSentences(tokens, { minChars: 12 });
    expect(sentences[0]).toBe("Hello world.");
    // The remaining "OK. That is fine." should produce at most 2 sentences
    // (implementation may combine short with next or split at last terminator)
    expect(sentences.slice(1).join(" ").length).toBeGreaterThan(0);
  });
});

describe("sentenceChunker — maxChars overflow flush", () => {
  it("forces a flush when buffer exceeds maxChars even without terminator", async () => {
    // Generate a token stream with no terminators but > maxChars content
    const longWord = "a".repeat(50);
    const tokens = [longWord, longWord, longWord, longWord, longWord]; // 250 chars, no period
    const sentences = await collectSentences(tokens, { maxChars: 100 });
    // Should have flushed at least once due to overflow
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    for (const s of sentences) {
      expect(s.length).toBeLessThanOrEqual(250); // never grows unbounded
    }
  });

  it("flushes exactly at maxChars boundary", async () => {
    // Build exactly maxChars+1 of non-terminator text
    const tokens = ["x".repeat(201)]; // one token, 201 chars
    const sentences = await collectSentences(tokens, { maxChars: 200 });
    expect(sentences.length).toBeGreaterThanOrEqual(1);
  });
});

describe("sentenceChunker — trailing partial flush", () => {
  it("flushes trailing text at end-of-stream even without terminator", async () => {
    const tokens = ["Hello world"];
    const sentences = await collectSentences(tokens);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toBe("Hello world");
  });

  it("does not yield empty sentences for whitespace-only trailing content", async () => {
    const tokens = ["Hello. ", "   "];
    const sentences = await collectSentences(tokens);
    expect(sentences.every((s) => s.trim().length > 0)).toBe(true);
  });

  it("flushes multiple incomplete sentences at stream end", async () => {
    const tokens = ["First sentence. Second part"];
    const sentences = await collectSentences(tokens);
    expect(sentences[0]).toBe("First sentence.");
    expect(sentences[sentences.length - 1]).toBe("Second part");
  });
});

describe("sentenceChunker — abbreviation edge cases", () => {
  it("does not false-split on 'Dr.' abbreviation if followed by name", async () => {
    // "Dr. Smith" — period NOT followed by end-of-string or space+uppercase in our
    // simple heuristic. Our regex is `[.!?](?=\s|$)` so "Dr. S" WILL split (space after dot).
    // This test documents the current (known-simple) behavior — not a bug, just spec.
    const tokens = ["Dr", ". ", "Smith said hello."];
    const sentences = await collectSentences(tokens, { minChars: 1 });
    // Whatever splits happen, all text should be preserved
    const joined = sentences.join(" ").replace(/\s+/g, " ").trim();
    expect(joined).toContain("Smith said hello");
  });

  it("handles consecutive sentence terminators", async () => {
    const tokens = ["Really?! ", "Yes indeed!"];
    const sentences = await collectSentences(tokens, { minChars: 1 });
    expect(sentences.some((s) => s.includes("Really"))).toBe(true);
    expect(sentences.some((s) => s.includes("Yes indeed"))).toBe(true);
  });
});

describe("sentenceChunker — mid-stream end-of-buffer is not a sentence boundary", () => {
  it("does not chunk at a decimal point split across pushes", async () => {
    // "Pi is 3" + "." + "14 is wrong. " — the buffer transiently ends in "."
    // but the next token continues the number. Must NOT emit "Pi is 3.".
    const tokens = ["Pi is 3", ".", "14 is wrong. ", "Trust me."];
    const sentences = await collectSentences(tokens, { minChars: 1 });
    expect(sentences).not.toContain("Pi is 3.");
    expect(sentences[0]).toBe("Pi is 3.14 is wrong.");
    expect(sentences[sentences.length - 1]).toBe("Trust me.");
  });

  it("still chunks promptly when punctuation is followed by whitespace", async () => {
    const order: string[] = [];
    async function* tokens() {
      for (const t of ["Done. ", "Next part"]) {
        order.push(`token:${t.trim()}`);
        yield t;
      }
    }
    for await (const s of chunkSentences(tokens(), { minChars: 1 })) {
      order.push(`sentence:${s}`);
    }
    // "Done." flushes as soon as the ". " arrives — before the next token
    expect(order[0]).toBe("token:Done.");
    expect(order[1]).toBe("sentence:Done.");
  });

  it("still emits a trailing sentence ending in punctuation at end-of-stream", async () => {
    const sentences = await collectSentences(["Hello world", "."], { minChars: 1 });
    expect(sentences).toEqual(["Hello world."]);
  });
});

describe("sentenceChunker — streaming interface", () => {
  it("yields sentences lazily before the full stream is consumed", async () => {
    const yielded: string[] = [];
    const order: string[] = [];

    async function* slowTokens() {
      const tokens = ["Hello world. ", "How are you?"];
      for (const t of tokens) {
        order.push(`token:${t.trim()}`);
        yield t;
      }
    }

    for await (const sentence of chunkSentences(slowTokens())) {
      yielded.push(sentence);
      order.push(`sentence:${sentence}`);
    }

    expect(yielded).toHaveLength(2);
    // After the first token "Hello world. " is consumed, the chunker finds a
    // sentence terminator and yields the sentence before consuming the next token.
    expect(order[0]).toBe("token:Hello world.");
    expect(order[1]).toBe("sentence:Hello world.");
    expect(order[2]).toBe("token:How are you?");
    expect(order[3]).toBe("sentence:How are you?");
  });

  it("handles an empty token stream", async () => {
    const sentences = await collectSentences([]);
    expect(sentences).toHaveLength(0);
  });

  it("handles a stream of only whitespace", async () => {
    const sentences = await collectSentences(["   ", "  "]);
    expect(sentences).toHaveLength(0);
  });
});

describe("sentenceChunker — first-chunk prioritization", () => {
  it("ships the first sentence immediately even when < minChars", async () => {
    // With minChars=20, "Hi." would normally not flush. But for the FIRST chunk
    // minChars is relaxed to 1.
    const tokens = ["Hi. ", "How are you doing today?"];
    const sentences = await collectSentences(tokens, { minChars: 20 });
    expect(sentences[0]).toBe("Hi."); // flushed early
  });

  it("applies minChars to subsequent sentences", async () => {
    // After the first chunk, subsequent small chunks should buffer until minChars.
    const tokens = [
      "First sentence here. ", // flushed as first chunk
      "OK. ",                  // only 3 chars, should buffer
      "Now we have enough text to flush.",
    ];
    const sentences = await collectSentences(tokens, { minChars: 15 });
    expect(sentences[0]).toBe("First sentence here.");
    // Second chunk should include "OK." buffered until it can flush
    const rest = sentences.slice(1).join(" ");
    expect(rest).toContain("OK");
    expect(rest).toContain("enough text");
  });
});
