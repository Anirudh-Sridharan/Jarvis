/**
 * Local documents ingest (second-brain capture breadth: PDFs / text / docs).
 *
 * Walks a directory for supported files, extracts their text (PDF via unpdf;
 * text/markdown passthrough), and captures each as chunked memory records via
 * memory.capture.captureDocument. Deterministic and idempotent — capture dedups
 * per document (a fast doc-level skip on the text hash) and per chunk, so
 * re-scanning an unchanged tree drops as duplicates while edited files
 * re-capture. Consolidation (the scheduler, or POST /consolidate) then promotes
 * the chunks into the searchable graph.
 *
 * This is the live (filesystem) layer; chunking and record-building live in the
 * leaf @jarvis/memory package, which never touches the filesystem. Extraction is
 * injectable so tests stay hermetic without a committed binary PDF.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { MemorySystem } from "@jarvis/memory";
import { extractText, type ExtractedDoc } from "./extractText.js";

export interface FilesIngestResult {
  /** Supported-extension files walked. */
  scanned: number;
  /** Documents that produced ≥1 chunk and were newly captured. */
  documents: number;
  /** Chunk records newly journaled. */
  chunks: number;
  /** Documents skipped because their content was already captured (unchanged). */
  duplicates: number;
  /** Files skipped — over the size cap, or no extractable text. */
  skipped: number;
  /** Read/extraction failures. */
  errors: number;
}

export type Extractor = (ext: string, bytes: Buffer, path: string) => Promise<ExtractedDoc | null>;

export interface FilesIngestDeps {
  memory: Pick<MemorySystem, "capture">;
  dir: string;
  /** Override extraction (default: real unpdf/text dispatch). */
  extract?: Extractor;
  /** Skip files larger than this many bytes (default 25 MB — protects the Air). */
  maxBytes?: number;
  /** Supported extensions, without the dot (default: pdf/txt/text/md/markdown/mdx). */
  exts?: string[];
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_EXTS = ["pdf", "txt", "text", "md", "markdown", "mdx"];

export async function runFilesIngest(deps: FilesIngestDeps): Promise<FilesIngestResult> {
  const res: FilesIngestResult = {
    scanned: 0,
    documents: 0,
    chunks: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
  };
  const extract = deps.extract ?? extractText;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const exts = new Set((deps.exts ?? DEFAULT_EXTS).map((e) => e.toLowerCase()));

  const files = await collectFiles(deps.dir, exts);

  for (const file of files) {
    res.scanned++;
    const relPath = relative(deps.dir, file);
    try {
      const st = await stat(file);
      if (st.size > maxBytes) {
        res.skipped++;
        continue;
      }
      const bytes = await readFile(file);
      const ext = extname(file).slice(1);
      const extracted = await extract(ext, bytes, relPath);
      if (!extracted) {
        res.skipped++; // unsupported by extractor or no usable text
        continue;
      }

      const result = await deps.memory.capture.captureDocument({
        path: relPath,
        text: extracted.text,
        title: extracted.title,
        mtime: new Date(st.mtimeMs).toISOString(),
        ext,
      });
      if (result.skipped) {
        res.duplicates++;
      } else {
        res.documents++;
        res.chunks += result.inserted;
      }
    } catch {
      res.errors++;
    }
  }

  return res;
}

/** Recursively collect files with a supported extension, skipping dot-directories. */
async function collectFiles(dir: string, exts: Set<string>): Promise<string[]> {
  const out: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // .git, .obsidian, .trash, …
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && exts.has(extname(entry.name).slice(1).toLowerCase())) {
        out.push(full);
      }
    }
  }

  await walk(dir);
  out.sort(); // deterministic order
  return out;
}
