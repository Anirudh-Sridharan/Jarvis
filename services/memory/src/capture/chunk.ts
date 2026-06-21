/**
 * Deterministic text chunker (document-ingest capture breadth).
 *
 * Splits a long document into overlapping, retrievable passages. Pure and
 * dependency-free (the leaf-package rule): no filesystem, no model. Boundaries
 * prefer paragraphs → sentences → words → a hard slice, so each chunk is a
 * coherent span whose char offsets map back into the source text. Determinism
 * matters — chunk text feeds content-hash dedup, so identical input must yield
 * identical chunks.
 *
 * Each chunk's `text` is the source slice `[charStart, charEnd)` optionally
 * prefixed with a word-aligned overlap window from the previous chunk (so a fact
 * straddling a boundary is recoverable from either side). Primary spans never
 * exceed `targetChars`; the overlap prefix is the only thing that can push
 * `text.length` past it.
 */

export interface ChunkOptions {
  /** Max chars in a chunk's primary span. */
  targetChars?: number;
  /** Chars of the previous chunk re-prepended for continuity (0 = disjoint). */
  overlapChars?: number;
  /** A trailing chunk shorter than this merges into its predecessor. */
  minChars?: number;
}

export interface TextChunk {
  index: number;
  text: string;
  /** Inclusive start offset of the primary span in the source text. */
  charStart: number;
  /** Exclusive end offset of the primary span in the source text. */
  charEnd: number;
}

interface Range {
  start: number;
  end: number;
}

const DEFAULTS = { targetChars: 1200, overlapChars: 150, minChars: 200 } as const;

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const targetChars = opts?.targetChars ?? DEFAULTS.targetChars;
  const overlapChars = opts?.overlapChars ?? DEFAULTS.overlapChars;
  const minChars = opts?.minChars ?? DEFAULTS.minChars;

  if (!text || !text.trim()) return [];

  // 1. Paragraph spans (blank-line separated), then split any over-target span.
  const pieces: Range[] = [];
  for (const para of segmentParagraphs(text)) {
    if (para.end - para.start <= targetChars) pieces.push(para);
    else pieces.push(...splitOversized(text, para, targetChars));
  }

  // 2. Greedily pack consecutive pieces while the span stays within target.
  const raw: Range[] = [];
  let cur: Range | null = null;
  for (const p of pieces) {
    if (!cur) cur = { start: p.start, end: p.end };
    else if (p.end - cur.start <= targetChars) cur.end = p.end;
    else {
      raw.push(cur);
      cur = { start: p.start, end: p.end };
    }
  }
  if (cur) raw.push(cur);

  // 3. Merge a tiny trailing chunk into its predecessor.
  if (raw.length >= 2) {
    const last = raw[raw.length - 1]!;
    if (last.end - last.start < minChars) {
      raw[raw.length - 2]!.end = last.end;
      raw.pop();
    }
  }

  // 4. Materialize: source slice + word-aligned overlap prefix from the prior chunk.
  return raw.map((r, i) => {
    const primary = text.slice(r.start, r.end);
    let body = primary;
    if (i > 0 && overlapChars > 0) {
      const prev = raw[i - 1]!;
      const overlap = wordAlignStart(text.slice(Math.max(prev.start, prev.end - overlapChars), prev.end));
      if (overlap) body = `${overlap} ${primary}`;
    }
    return { index: i, text: body, charStart: r.start, charEnd: r.end };
  });
}

/** Blank-line separated paragraph spans, edge-trimmed, with absolute offsets. */
function segmentParagraphs(text: string): Range[] {
  const ranges: Range[] = [];
  const sep = /\n[ \t]*\n/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(text))) {
    pushTrimmed(ranges, text, start, m.index);
    start = sep.lastIndex;
  }
  pushTrimmed(ranges, text, start, text.length);
  return ranges;
}

function pushTrimmed(ranges: Range[], text: string, s: number, e: number): void {
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (e > s) ranges.push({ start: s, end: e });
}

/** Split a span longer than target into sub-spans at sentence/word/hard cuts. */
function splitOversized(text: string, range: Range, target: number): Range[] {
  const out: Range[] = [];
  let s = range.start;
  while (range.end - s > target) {
    const windowEnd = s + target;
    let cut = lastBoundary(text, s, windowEnd);
    if (cut <= s) cut = windowEnd; // no boundary in window → hard slice
    out.push({ start: s, end: cut });
    while (cut < range.end && /\s/.test(text[cut]!)) cut++; // skip separating whitespace
    s = cut;
  }
  if (range.end - s > 0) out.push({ start: s, end: range.end });
  return out;
}

/** Latest sentence end (`.`/`!`/`?` + space) in (s, windowEnd], else latest whitespace. */
function lastBoundary(text: string, s: number, windowEnd: number): number {
  const limit = Math.min(windowEnd, text.length);
  let sentence = -1;
  for (let i = s; i < limit; i++) {
    const c = text[i]!;
    if ((c === "." || c === "!" || c === "?") && (i + 1 >= text.length || /\s/.test(text[i + 1]!))) {
      sentence = i + 1;
    }
  }
  if (sentence > s) return sentence;
  for (let i = limit - 1; i > s; i--) {
    if (/\s/.test(text[i]!)) return i;
  }
  return -1;
}

/** Drop a leading partial word so the overlap window starts on a word boundary. */
function wordAlignStart(s: string): string {
  const ws = s.search(/\s/);
  return (ws === -1 ? s : s.slice(ws)).trim();
}
