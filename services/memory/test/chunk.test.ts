/**
 * Tests for the deterministic text chunker (document-ingest capture breadth).
 *
 * The chunker turns a long document into overlapping, retrievable passages whose
 * char offsets map back into the source text. It must be deterministic (stable
 * dedup keys depend on it) and respect paragraph/sentence/word boundaries.
 */

import { describe, it, expect } from "vitest";
import { chunkText } from "../src/capture/chunk.js";

/** Fixed-width tokens ("tok000", "tok001", …) → predictable lengths in tests. */
function tokens(n: number): string {
  return Array.from({ length: n }, (_, i) => `tok${String(i).padStart(3, "0")}`).join(" ");
}

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  \n")).toEqual([]);
  });

  it("returns a single chunk for text under the target size", () => {
    const chunks = chunkText("Hello world", { targetChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, text: "Hello world", charStart: 0, charEnd: 11 });
  });

  it("is deterministic — same input yields identical chunks", () => {
    const text = tokens(120);
    expect(chunkText(text, { targetChars: 60, overlapChars: 15 })).toEqual(
      chunkText(text, { targetChars: 60, overlapChars: 15 }),
    );
  });

  it("splits a long single paragraph into multiple bounded chunks", () => {
    const text = tokens(100); // ~699 chars, no blank lines
    const chunks = chunkText(text, { targetChars: 60, overlapChars: 15, minChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // primary span never exceeds target; text adds at most one overlap window
      expect(c.charEnd - c.charStart).toBeLessThanOrEqual(60);
      expect(c.text.length).toBeLessThanOrEqual(60 + 15 + 8);
    }
  });

  it("overlaps consecutive chunks when overlapChars > 0", () => {
    const text = tokens(200);
    const chunks = chunkText(text, { targetChars: 60, overlapChars: 20, minChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    const w0 = chunks[0]!.text.trim().split(/\s+/);
    const w1 = chunks[1]!.text.trim().split(/\s+/);
    // the last token of chunk 0 reappears inside chunk 1 (the overlap window)
    expect(w1).toContain(w0[w0.length - 1]);
  });

  it("produces disjoint adjacent chunks when overlapChars = 0", () => {
    const text = tokens(200);
    const chunks = chunkText(text, { targetChars: 60, overlapChars: 0, minChars: 10 });
    const w0 = chunks[0]!.text.trim().split(/\s+/);
    const w1 = chunks[1]!.text.trim().split(/\s+/);
    expect(w1).not.toContain(w0[w0.length - 1]);
  });

  it("splits on paragraph boundaries", () => {
    const text = "Alpha beta gamma.\n\nDelta epsilon zeta."; // paragraphs of 17 and 19 chars
    const chunks = chunkText(text, { targetChars: 20, overlapChars: 0, minChars: 5 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain("Alpha");
    expect(chunks[0]!.text).not.toContain("Delta");
    expect(chunks[1]!.text).toContain("Delta");
  });

  it("merges a tiny trailing chunk into its predecessor (minChars)", () => {
    const text = tokens(16); // ~111 chars
    // remainder after the first ~100-char chunk (~13 chars) is below minChars → merged
    expect(chunkText(text, { targetChars: 100, overlapChars: 0, minChars: 40 })).toHaveLength(1);
    // with a low floor the remainder survives as its own chunk
    expect(chunkText(text, { targetChars: 100, overlapChars: 0, minChars: 5 }).length).toBe(2);
  });

  it("exposes monotonic, source-mapped offsets", () => {
    const chunks = chunkText(tokens(100), { targetChars: 60, overlapChars: 0, minChars: 10 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.charEnd).toBeGreaterThan(chunks[i]!.charStart);
      if (i > 0) {
        expect(chunks[i]!.charStart).toBeGreaterThan(chunks[i - 1]!.charStart);
        expect(chunks[i]!.charStart).toBeGreaterThanOrEqual(chunks[i - 1]!.charEnd);
      }
    }
  });
});
