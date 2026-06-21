/**
 * Document text extraction (core live layer for the documents connector).
 *
 * Dispatches by file extension: utf-8 passthrough for text/markdown, and PDF via
 * unpdf (pure-JS, offline). Extraction is the I/O-adjacent, dependency-backed
 * concern, so it lives in core — the leaf @jarvis/memory package only chunks the
 * resulting plain text and never touches the filesystem or a PDF library.
 *
 * The PDF parser is injectable (`ParsePdf`) so tests stay hermetic and offline:
 * a fake parser exercises the dispatch and title/empty handling without a
 * committed binary PDF. The default lazily imports unpdf only when a real PDF is
 * actually parsed.
 */

import { basename, extname } from "node:path";

export interface ExtractedDoc {
  text: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export type ParsePdf = (bytes: Uint8Array) => Promise<{ text: string; pages?: number }>;

export interface ExtractDeps {
  parsePdf?: ParsePdf;
}

/** Extensions handled as raw utf-8 text. */
const TEXT_EXTS = new Set(["txt", "text", "md", "markdown", "mdx"]);

/**
 * Extract plain text from a file's bytes. Returns null for unsupported types or
 * when no usable text is present (e.g. a scanned/image-only PDF) — the ingest
 * loop treats null as "skip", not an error.
 */
export async function extractText(
  ext: string,
  bytes: Buffer,
  path: string,
  deps?: ExtractDeps,
): Promise<ExtractedDoc | null> {
  const e = ext.replace(/^\./, "").toLowerCase();
  const title = fileStem(path);

  if (TEXT_EXTS.has(e)) {
    const text = bytes.toString("utf8");
    return text.trim() ? { text, title } : null;
  }

  if (e === "pdf") {
    const parse = deps?.parsePdf ?? defaultParsePdf;
    const { text, pages } = await parse(new Uint8Array(bytes));
    if (!text.trim()) return null;
    return { text, title, meta: pages != null ? { pages } : undefined };
  }

  return null; // unsupported extension → skip
}

/** Filename stem (basename without its extension). */
function fileStem(path: string): string {
  return basename(path, extname(path));
}

/** Default PDF parser — lazily imports unpdf so it's never loaded in fake-injected tests. */
const defaultParsePdf: ParsePdf = async (bytes) => {
  const { extractText: pdfExtractText } = await import("unpdf");
  const { text, totalPages } = await pdfExtractText(bytes, { mergePages: true });
  return { text, pages: totalPages };
};
