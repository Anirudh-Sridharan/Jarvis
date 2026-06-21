/**
 * Email capture adapter (second-brain capture breadth #3: Gmail message bodies).
 *
 * Pure — NO network access (the leaf-package rule): the core layer fetches recent
 * messages from Gmail (search + thread.get) and hands each message's decoded
 * plain-text body here to be chunked and turned into ExperienceRecords.
 *
 * Chunks-only data model (mirrors the document adapter): one record per chunk,
 * all sharing `doc_id = messageId`. Emails are immutable, so the message id is a
 * stable, globally-unique grouping key — no text hash needed, and no doc-level
 * fast-skip (the per-chunk dedup_key UNIQUE backstop is sufficient idempotency).
 * A self-describing header prefix (subject + from/to/date) makes each chunk embed
 * well; per-chunk dedup is content-hash based so a re-scan drops as duplicates.
 */

import type { ExperienceRecord, CaptureEntity } from "../../types.js";
import { buildExternalRecord } from "../experience.js";
import { chunkText, type ChunkOptions } from "../chunk.js";

export interface EmailRecordInput {
  /** Gmail message id (stable, immutable) — also the chunk group's doc_id. */
  messageId: string;
  /** Gmail thread id — groups messages of one conversation in payload. */
  threadId: string;
  /** Raw `From` header (e.g. `Alice <alice@x.com>`). */
  from: string;
  /** Raw `To` header (may be a comma-separated list). */
  to: string;
  subject: string;
  /** Raw `Date` header (RFC 2822); parsed to ISO for the record timestamp. */
  date: string;
  /** Decoded text/plain body. */
  body: string;
  chunkOpts?: ChunkOptions;
}

export function buildEmailRecords(opts: EmailRecordInput): ExperienceRecord[] {
  const chunks = chunkText(opts.body, opts.chunkOpts);
  if (chunks.length === 0) return [];

  const header = `${opts.subject}\nFrom: ${opts.from} · To: ${opts.to} · ${opts.date}`;
  const entities = addressEntities(opts.from, opts.to);
  const timestamp = parseDate(opts.date);

  return chunks.map((chunk) =>
    buildExternalRecord({
      source: "gmail",
      type: "email",
      nativeId: `${opts.messageId}#${chunk.index}`,
      text: `${header}\n\n${chunk.text}`,
      timestamp,
      actor: "user",
      payload: {
        message_id: opts.messageId,
        thread_id: opts.threadId,
        from: opts.from,
        to: opts.to,
        subject: opts.subject,
        date: opts.date,
        doc_id: opts.messageId,
        chunk_index: chunk.index,
        chunk_count: chunks.length,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
      },
      entities,
      // Hash the chunk body so re-scans drop as duplicates.
      content: chunk.text,
    }),
  );
}

/** Parse an RFC-2822 Date header to ISO; falls back to now on an unparseable value. */
function parseDate(date: string): string {
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

/** Derive deduped person/email entities from the From + To headers. */
function addressEntities(from: string, to: string): CaptureEntity[] {
  const out: CaptureEntity[] = [];
  const seen = new Set<string>();
  const add = (e: CaptureEntity) => {
    const key = `${e.kind}:${e.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  };
  for (const addr of [...parseAddresses(from), ...parseAddresses(to)]) {
    if (addr.name) add({ kind: "person", value: addr.name });
    add({ kind: "email", value: addr.email });
  }
  return out;
}

interface ParsedAddress {
  name?: string;
  email: string;
}

/**
 * Dependency-free parser for a header address list. Handles
 * `Name <a@b.com>`, `"Last, First" <a@b.com>`, bare `a@b.com`, and
 * comma-separated combinations. The split is quote-aware so a comma inside a
 * quoted display name is not mistaken for a list separator. Entries without a
 * recognizable email address (one containing `@`) are dropped.
 */
export function parseAddresses(header: string): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  for (const partRaw of splitOutsideQuotes(header)) {
    const part = partRaw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*?)<([^>]+)>\s*$/);
    if (angle && angle[2]!.includes("@")) {
      const name = stripQuotes(angle[1]!.trim());
      const email = angle[2]!.trim().toLowerCase();
      out.push(name ? { name, email } : { email });
      continue;
    }
    // No (or malformed) angle address — scan for a bare address anywhere in the part.
    const bare = part.match(/[^\s<>@]+@[^\s<>@]+/);
    if (bare) out.push({ email: bare[0].toLowerCase() });
  }
  return out;
}

/** Split on commas that are NOT inside a double-quoted display name. */
function splitOutsideQuotes(header: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of header) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function stripQuotes(s: string): string {
  return s.replace(/^"(.*)"$/, "$1").trim();
}
