/**
 * Tests for the document text extractor (core live layer).
 *
 * Extraction dispatches by extension: utf-8 passthrough for text/markdown, and
 * PDF via an INJECTED parser (the real default lazy-imports unpdf) so the suite
 * stays hermetic and offline — no committed binary PDF required.
 */

import { describe, it, expect } from "vitest";
import { extractText } from "../src/memory/extractText.js";

describe("extractText", () => {
  it("passes through utf-8 text files, titling from the filename stem", async () => {
    const r = await extractText("txt", Buffer.from("Hello world"), "notes/a.txt");
    expect(r).toEqual({ text: "Hello world", title: "a" });
  });

  it("handles markdown extensions", async () => {
    const r = await extractText("md", Buffer.from("# Title\n\nbody"), "b.md");
    expect(r?.text).toContain("body");
    expect(r?.title).toBe("b");
  });

  it("normalizes a leading dot and uppercase extension", async () => {
    const r = await extractText(".TXT", Buffer.from("hi"), "c.TXT");
    expect(r?.text).toBe("hi");
  });

  it("returns null for an unsupported extension", async () => {
    expect(await extractText("exe", Buffer.from("MZ"), "x.exe")).toBeNull();
  });

  it("returns null for empty/whitespace text", async () => {
    expect(await extractText("txt", Buffer.from("   \n"), "blank.txt")).toBeNull();
  });

  it("extracts PDF text via the injected parser", async () => {
    const r = await extractText("pdf", Buffer.from("%PDF-1.4"), "papers/deep.pdf", {
      parsePdf: async () => ({ text: "Extracted body", pages: 3 }),
    });
    expect(r).toMatchObject({ text: "Extracted body", title: "deep", meta: { pages: 3 } });
  });

  it("returns null for a PDF with no extractable text (scanned)", async () => {
    const r = await extractText("pdf", Buffer.from("%PDF"), "scan.pdf", {
      parsePdf: async () => ({ text: "   " }),
    });
    expect(r).toBeNull();
  });
});
