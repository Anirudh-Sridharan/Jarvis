/**
 * Markdown / Obsidian capture adapter (feature 3, second-brain ingest).
 *
 * Pure parsing — NO filesystem access (the leaf-package rule): the core layer
 * walks the vault and reads files, then hands raw markdown here to be turned
 * into an ExperienceRecord. Parses YAML frontmatter, inline `#tags`, and
 * `[[wikilinks]]` into capture entities.
 *
 * Dedup is content-hash based (the raw markdown), so re-scanning an unchanged
 * vault is a no-op while an edited note is re-captured (the bi-temporal journal
 * keeps the prior version; consolidation reconciles).
 */

import { createHash } from "node:crypto";
import type { ExperienceRecord, CaptureEntity } from "../../types.js";
import { buildExternalRecord } from "../experience.js";
import { chunkText, type ChunkOptions } from "../chunk.js";

/**
 * Long notes are chunked at the capture defer threshold (≈2048 chars), so only
 * notes that would otherwise become a single deferred-embedding blob are split;
 * shorter notes stay single records (byte-identical to before — no re-capture
 * churn on the next vault scan).
 */
const MARKDOWN_CHUNK_OPTS: ChunkOptions = { targetChars: 2048, overlapChars: 200, minChars: 400 };

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Tags from frontmatter `tags` plus inline `#tags`, deduped. */
  tags: string[];
  /** `[[wikilink]]` targets (alias/heading stripped), deduped. */
  links: string[];
  /** `title` from frontmatter, if present. */
  title?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
// Obsidian inline tag: `#tag`, must start with a letter/underscore (not a
// markdown heading `# `, and not a pure number). Preceded by start/space.
const INLINE_TAG_RE = /(?:^|\s)#([A-Za-z_][\w/-]*)/g;

/** Parse markdown into frontmatter + body + tags + wikilinks. */
export function parseMarkdownNote(raw: string): ParsedMarkdown {
  let body = raw;
  let frontmatter: Record<string, unknown> = {};

  const fm = FRONTMATTER_RE.exec(raw);
  if (fm) {
    frontmatter = parseFrontmatter(fm[1] ?? "");
    body = raw.slice(fm[0].length);
  }

  const tags = new Set<string>();
  for (const t of toStringArray(frontmatter["tags"])) tags.add(normalizeTag(t));
  for (const m of body.matchAll(INLINE_TAG_RE)) {
    if (m[1]) tags.add(normalizeTag(m[1]));
  }

  const links = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? "").split("|")[0]?.split("#")[0]?.trim();
    if (target) links.add(target);
  }

  const title = typeof frontmatter["title"] === "string" ? (frontmatter["title"] as string) : undefined;

  return {
    frontmatter,
    body,
    tags: [...tags].filter((t) => t.length > 0),
    links: [...links],
    title,
  };
}

/**
 * Build an ExperienceRecord from a markdown note.
 * `path` is the stable native id (e.g. the vault-relative path). `mtime` (ISO)
 * sets the event timestamp; defaults to now.
 */
export function buildMarkdownRecord(opts: {
  path: string;
  raw: string;
  mtime?: string;
  /** Override title; otherwise frontmatter.title or the filename stem is used. */
  title?: string;
}): ExperienceRecord {
  const parsed = parseMarkdownNote(opts.raw);
  const title = parsed.title ?? opts.title ?? fileStem(opts.path);

  const bodyTrimmed = parsed.body.trim();
  const text = title ? `${title}\n\n${bodyTrimmed}`.trim() : bodyTrimmed;

  return buildExternalRecord({
    source: "obsidian",
    type: "note",
    nativeId: opts.path,
    text,
    timestamp: opts.mtime ?? new Date().toISOString(),
    actor: "user",
    payload: {
      path: opts.path,
      title,
      tags: parsed.tags,
      links: parsed.links,
      frontmatter: parsed.frontmatter,
    },
    entities: markdownEntities(parsed),
    // Hash the raw note so edits re-capture and unchanged notes drop as dups.
    content: opts.raw,
  });
}

/**
 * Build chunked records for a markdown note. A note whose body fits the defer
 * threshold yields exactly one record (identical to buildMarkdownRecord — no
 * churn); a longer note is split into multiple title-prefixed chunk records
 * (source "obsidian", per-chunk content-hash dedup, shared doc_id) so it becomes
 * retrievable passages instead of one deferred blob.
 */
export function buildMarkdownRecords(opts: {
  path: string;
  raw: string;
  mtime?: string;
  title?: string;
  chunkOpts?: ChunkOptions;
}): ExperienceRecord[] {
  const parsed = parseMarkdownNote(opts.raw);
  const chunks = chunkText(parsed.body, opts.chunkOpts ?? MARKDOWN_CHUNK_OPTS);
  if (chunks.length <= 1) return [buildMarkdownRecord(opts)];

  const title = parsed.title ?? opts.title ?? fileStem(opts.path);
  const entities = markdownEntities(parsed);
  const timestamp = opts.mtime ?? new Date().toISOString();
  const docId = createHash("sha256").update(opts.raw).digest("hex");

  return chunks.map((chunk) =>
    buildExternalRecord({
      source: "obsidian",
      type: "note",
      nativeId: `${opts.path}#${chunk.index}`,
      text: title ? `${title}\n\n${chunk.text}` : chunk.text,
      timestamp,
      actor: "user",
      payload: {
        path: opts.path,
        title,
        tags: parsed.tags,
        links: parsed.links,
        frontmatter: parsed.frontmatter,
        doc_id: docId,
        chunk_index: chunk.index,
        chunk_count: chunks.length,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
      },
      entities,
      // Hash the chunk body so edits re-capture only changed chunks.
      content: chunk.text,
    }),
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Wikilinks and tags both become "tag" entities (the generic bucket — the
 * consolidation EXTRACT stage derives typed entities from the text later).
 */
function markdownEntities(parsed: ParsedMarkdown): CaptureEntity[] {
  const seen = new Set<string>();
  const entities: CaptureEntity[] = [];
  for (const v of [...parsed.links, ...parsed.tags]) {
    if (seen.has(v)) continue;
    seen.add(v);
    entities.push({ kind: "tag", value: v });
  }
  return entities;
}

/** Minimal YAML frontmatter parser: scalars, inline `[a, b]`, and block lists. */
function parseFrontmatter(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!key) continue;

    if (rest === "") {
      // Possible block list: subsequent `- item` lines.
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i] ?? "")) {
        items.push(stripQuotes((lines[i] ?? "").replace(/^\s*-\s+/, "").trim()));
        i++;
      }
      out[key] = items.length > 0 ? items : "";
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      out[key] = stripQuotes(rest);
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Coerce a frontmatter value into a string[] (array, comma string, or scalar). */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

/** Strip a leading `#` and surrounding whitespace from a tag. */
function normalizeTag(t: string): string {
  return t.replace(/^#/, "").trim();
}

/** Filename stem from a path (no node:path — leaf stays dependency-free). */
function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.md$/i, "");
}
