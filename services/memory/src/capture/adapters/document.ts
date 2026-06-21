/**
 * Document capture adapter (second-brain capture breadth: PDFs / text / docs).
 *
 * Pure — NO filesystem access (the leaf-package rule): the core layer walks the
 * directory, reads bytes, and extracts plain text (PDF→text lives in core where
 * the dependency belongs), then hands the text here to be chunked and turned
 * into ExperienceRecords.
 *
 * Chunks-only data model: one record per chunk, all sharing a `doc_id`
 * (sha256 of the document's full text, computed by the caller). No parent
 * record — the existing "retrieval returns whole records" contract and the
 * single-vector-per-record embedding store stay intact, and the chunk title
 * prefix makes each record self-describing for the embedder. Per-chunk dedup is
 * content-hash based (the chunk body), so a re-scan of an unchanged document is
 * a no-op while an edit re-captures the affected chunks; the bi-temporal journal
 * keeps prior versions and consolidation reconciles.
 */

import type { ExperienceRecord, CaptureEntity } from "../../types.js";
import { buildExternalRecord } from "../experience.js";
import { chunkText, type ChunkOptions } from "../chunk.js";

export function buildDocumentChunkRecords(opts: {
  /** Stable native id for the document (e.g. the scan-root-relative path). */
  path: string;
  /** sha256 of the full extracted text — groups a document's chunks. */
  docId: string;
  /** The document's extracted plain text. */
  text: string;
  /** Display title; defaults to the filename stem. */
  title?: string;
  /** Event timestamp (ISO); defaults to now. */
  mtime?: string;
  /** File extension (e.g. "pdf"), recorded in payload. */
  ext?: string;
  chunkOpts?: ChunkOptions;
}): ExperienceRecord[] {
  const chunks = chunkText(opts.text, opts.chunkOpts);
  if (chunks.length === 0) return [];

  const title = opts.title ?? fileStem(opts.path);
  const entities = pathEntities(opts.path);
  const timestamp = opts.mtime ?? new Date().toISOString();

  return chunks.map((chunk) => {
    const body = title ? `${title}\n\n${chunk.text}` : chunk.text;
    return buildExternalRecord({
      source: "files",
      type: "document",
      nativeId: `${opts.path}#${chunk.index}`,
      text: body,
      timestamp,
      actor: "user",
      payload: {
        path: opts.path,
        title,
        ext: opts.ext,
        doc_id: opts.docId,
        chunk_index: chunk.index,
        chunk_count: chunks.length,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
      },
      entities,
      // Hash the chunk body so edits re-capture and unchanged chunks drop as dups.
      content: chunk.text,
    });
  });
}

/** Filename stem from a path (no node:path — the leaf stays dependency-free). */
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/** Lightweight tag entities: filename stem + immediate parent folder. */
function pathEntities(path: string): CaptureEntity[] {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  const file = segments.pop();
  const out = new Set<string>();
  if (file) out.add(file.replace(/\.[^.]+$/, ""));
  const parent = segments.pop();
  if (parent) out.add(parent);
  return [...out].filter((v) => v.length > 0).map((value) => ({ kind: "tag", value }));
}
