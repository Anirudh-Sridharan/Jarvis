# Local Documents & PDF Ingest (with first-class chunking)

- **Date:** 2026-06-20
- **Status:** v1 (Phases 1–2) + Phase 3 (long-note chunking) implemented & tested — `@jarvis/memory` 214 green, `@jarvis/core` 197 green. Phases 4–5 remain optional follow-ons.
- **Feature:** Capture-breadth connector #2 — local documents (`source: "files"`)
- **Builds on:** Obsidian/markdown vault ingest (`20c709d`), sqlite-vec index, grounded REFLECT
- **Theme:** second-brain repositioning → capture breadth is the recorded next lever

## 1. Summary

Add a **local-documents capture connector** that walks a directory for PDFs, plain
text, and markdown, extracts their text, **chunks long documents into retrievable
passages**, and captures each chunk as a dedup-aware `ExperienceRecord`. It mirrors
the Obsidian vault ingest exactly (CLI-driven, idempotent, filesystem-on-core /
parsing-on-leaf), and introduces a **reusable chunking layer** that also fixes a
latent retrieval defect affecting everything already captured.

## 2. Motivation

The 20-feature roadmap is complete; the frontier is the memory engine, and the
recorded next lever is **capture breadth**. Today the memory graph ingests: chat
turns, calendar events, health/work *digests*, Gmail *counts* (not content), and the
Obsidian markdown vault. It does **not** ingest PDFs, arbitrary local files, email
bodies, or web content. Personal documents (papers, manuals, saved articles, books,
receipts, exports) are high-signal and low-noise — the cleanest next increment of
"capture everything."

**The chunking gap (load-bearing).** Capture embeds any record whose text is
`≤ 2048` chars immediately; longer text is stored as a **single** record with a
**deferred** embedding (`services/memory/src/capture/capture.ts:14,42-56`). A 30-page
PDF — or even a long Obsidian note today — therefore collapses to *one* vector, which
cannot represent the document for semantic recall. So the highest-value capture
feature also forces a **chunking layer**, and that layer retroactively upgrades
retrieval quality for long notes already in the store (Phase 3).

## 3. Scope

**In (v1 = Phases 1–2):**
- File types: `.pdf`, `.txt`, `.md` / `.markdown` (plain), `.text`.
- Recursive directory walk, dot-dir skip, size cap, idempotent re-scan.
- Deterministic text chunking with overlap; one `ExperienceRecord` per chunk.
- CLI: `npm run connect -- sync files <path>` + `JARVIS_FILES_DIR` env default.

**Out (deferred, explicitly):**
- `.docx` / `.rtf` / `.html` extraction (Phase 5 follow-on; `mammoth`/readability).
- OCR of scanned/image PDFs (no embedded text → skipped, logged).
- Web/browser capture (separate connector; `SourceKind: "browser"` already reserved).
- Email backfill (separate capture-breadth feature; tracked as the follow-up lever).
- Dashboard surfacing is **optional Phase 4**, not v1 (matches Obsidian = CLI-only).

## 4. Current architecture (the seam we extend)

| Concern | Lives in | Reference |
|---|---|---|
| Filesystem walk + read | **core** (live layer) | `services/core/src/memory/vaultIngest.ts` |
| Parse → `ExperienceRecord` | **leaf** `@jarvis/memory` (pure) | `services/memory/src/capture/adapters/markdown.ts` |
| Capture pipeline (dedup→journal→embed) | leaf | `services/memory/src/capture/capture.ts` |
| Record builder + dedup key | leaf | `services/memory/src/capture/experience.ts:23-30,122-158` |
| `SourceId` / `ExperienceType` unions | leaf | `services/memory/src/types.ts:109-128` |
| CLI sync dispatch | core | `services/core/src/cli/connect.ts` (`syncObsidian`, `SYNCABLE_SOURCES`) |
| Consolidation (promote → graph) | leaf | unchanged — consumes `consolidation_pending` records |

Adding a source is a clean 5-step seam (extend unions → adapter → capture method →
expose on `MemorySystem` → wire a trigger). The dedup, embedding, and consolidation
machinery are already generic over `source`.

## 5. Design

### 5.1 Data model — chunks-only

Each chunk becomes one ordinary `ExperienceRecord`. **No parent record, no
multi-vector record** — both would perturb the embedding store cardinality and the
"retrieval returns whole records" contract. A shared `doc_id` in `payload` groups a
document's chunks; consolidation's EXTRACT/REFLECT already synthesizes across records,
so grouping at the surface is sufficient.

Per-chunk record:
- `source: "files"`, `type: "document"`, `actor: "user"`, `via: "in_process"`.
- `text`: `"${title}\n\n${chunkBody}"` (title prefix makes each chunk self-describing
  for embedding — same trick the markdown adapter uses).
- `payload`: `{ path, title, ext, doc_id, chunk_index, chunk_count, char_start, char_end, page? }`.
- `entities`: lightweight `tag` entities from the containing folder + filename stem;
  the consolidation EXTRACT stage derives typed entities later.
- `raw_ref`: `raw/files/${doc_id}/${chunk_index}.json`.
- `dedup_key`: `computeDedupKey("files", \`${path}#${chunk_index}\`, chunkText)`.

`doc_id = sha256(fullExtractedText)` — changes iff the document's text changes.

### 5.2 Layering (honor the leaf rule)

- **core (live):** filesystem walk + read bytes + **text extraction** (PDF/txt/md).
  Extraction is I/O-adjacent and library-backed, so the new dependency lives in core,
  consistent with the markdown precedent (leaf parsing stays dependency-free).
- **leaf `@jarvis/memory` (pure, no deps beyond `node:crypto`):** the **chunker** and
  the **document adapter** (`text → ExperienceRecord[]`), fully unit-testable offline.

### 5.3 Chunking algorithm (deterministic, no LLM)

`chunkText(text, opts)` with defaults `targetChars=1200`, `overlapChars=150`,
`minChars=200`:
1. Split into paragraphs on blank lines; greedily pack paragraphs up to `targetChars`.
2. A single paragraph over budget splits on sentence boundaries, then whitespace, then
   a hard slice (guarantees progress).
3. Prepend the tail `overlapChars` of the previous chunk (on a word boundary) for
   context continuity (lost-in-the-middle aware).
4. A trailing chunk under `minChars` merges into its predecessor.
Deterministic: identical input → identical chunks (required for stable dedup). Each
chunk ≤ ~1200 chars < the 2048 defer threshold → **embedded immediately** (the
retrieval win: no more deferred giant blobs).

### 5.4 Text extraction (core, injectable)

`extractText(ext, bytes, path) → { text, title?, meta? } | null`:
- `.txt`/`.md`/`.markdown`/`.text`: utf-8 passthrough (markdown extraction strips
  frontmatter via the existing leaf parser where useful; title = filename stem).
- `.pdf`: **`unpdf`** (ESM, pure-JS, no native deps, fully offline; wraps pdf.js) →
  concatenated page text; `page` recorded per chunk when cheaply available; empty text
  (scanned PDF) → `null` → skipped + logged.
- Unknown extension → `null` (skipped, not an error).
- Extraction is an **injected interface** on `runFilesIngest` (default = real
  `extractText`) so core tests stay hermetic with a fake extractor — no committed
  binary PDF required for the suite to pass.

### 5.5 Capture flow

```
CaptureService.captureDocument({ path, text, title?, mtime?, ext? }):
  docId = sha256(text)
  if store.documentExists(docId):  return { docId, skipped: true, inserted: 0, total: 0 }
  records = buildDocumentChunkRecords({ path, docId, text, title, mtime, ext })
  for r of records: capture(r)            // chunk-level UNIQUE(dedup_key) backstop
  return { docId, skipped, inserted, total: records.length }
```

### 5.6 Idempotency — two-tier dedup

1. **Doc-level fast skip (optimization):** `store.documentExists(doc_id)` short-circuits
   re-parsing/chunking an unchanged document. Implementation decided in Phase 1 against
   the real schema — prefer `WHERE source='files' AND json_extract(payload,'$.doc_id')=?`
   (SQLite JSON1 is builtin); fall back to a nullable indexed `doc_id` column if needed.
2. **Chunk-level dedup (correctness):** the existing `insertExperienceIfNew`
   `UNIQUE(dedup_key)` guarantees no duplicate chunks even without tier 1, so a crashed
   mid-document run is self-healing on re-run.

Edited documents: tier-1 misses (text changed → new `doc_id`), chunks are re-captured
as **new** records; prior chunks remain in the bi-temporal journal (per the
never-hard-delete invariant) and consolidation reconciles. Unchanged docs are a no-op.

### 5.7 Embedding & consolidation — no changes

Chunks are normal records (`consolidation_pending: true`); EXTRACT/REFLECT promote them
unchanged. Higher chunk volume raises consolidation load, but consolidation is
batched/HF and was explicitly designed for "capture everything → consolidate
aggressively."

### 5.8 Wiring

- **CLI (`connect.ts`):** add `syncFiles(path)` alongside `syncObsidian`; dispatch
  `sync files <path>`; default to `JARVIS_FILES_DIR` when no path given; help text line.
  Add `"files"` where the document source needs to be recognized (note: `files` is
  filesystem/`in_process`, not in the OAuth `SYNCABLE_SOURCES` list).
- **Dashboard (optional Phase 4):** add `"files"` to `/api/connectors/sync` allowlist
  with an env-default path, plus a `ConnectorPanel` "Sync documents" control. Needs a
  path input or a configured `JARVIS_FILES_DIR`; deferred from v1.

### 5.9 Error handling & limits

- Unreadable file / extraction throw → `errors++`, continue (vault-ingest pattern).
- Encrypted/corrupt/scanned PDF (no text) → skip + log, not a hard error.
- **Size cap** (default 25 MB, configurable) to protect the 16 GB Air; oversize → skip+log.
- Empty extracted text → skip (mirrors empty-markdown handling).
- Result envelope: `{ scanned, documents, chunks, duplicates, skipped, errors }`.

## 6. Interfaces (new)

```ts
// leaf: services/memory/src/capture/chunk.ts
export interface ChunkOptions { targetChars?: number; overlapChars?: number; minChars?: number }
export interface TextChunk { index: number; text: string; charStart: number; charEnd: number }
export function chunkText(text: string, opts?: ChunkOptions): TextChunk[]

// leaf: services/memory/src/capture/adapters/document.ts
export function buildDocumentChunkRecords(opts: {
  path: string; docId: string; text: string;
  title?: string; mtime?: string; ext?: string; chunkOpts?: ChunkOptions;
}): ExperienceRecord[]

// leaf: CaptureService (capture.ts) + exposed on MemorySystem.capture
captureDocument(opts: { path: string; text: string; title?: string; mtime?: string; ext?: string }):
  Promise<{ docId: string; skipped: boolean; inserted: number; total: number }>

// leaf: MemoryStore
documentExists(docId: string): boolean

// leaf: types.ts
type SourceId = ... | "files"
type ExperienceType = ... | "document"

// core: services/core/src/memory/extractText.ts
export interface Extractor { extract(ext: string, bytes: Buffer, path: string):
  Promise<{ text: string; title?: string; meta?: Record<string, unknown> } | null> }

// core: services/core/src/memory/filesIngest.ts
export interface FilesIngestResult {
  scanned: number; documents: number; chunks: number; duplicates: number; skipped: number; errors: number }
export function runFilesIngest(deps: {
  memory: Pick<MemorySystem, "capture">; dir: string;
  extract?: Extractor; maxBytes?: number; exts?: string[];
}): Promise<FilesIngestResult>
```

## 7. Data flow

```
connect sync files <dir>            (or JARVIS_FILES_DIR)
  └─ runFilesIngest({ memory, dir, extract })          [core]
       walk dir → supported, size-capped files (dot-dirs skipped)
       for each file:
         bytes        = read(file)
         { text, ... } = extract(ext, bytes, path)      [core: unpdf | utf8]
         if !text.trim(): skipped++; continue
         { skipped, inserted, total } = memory.capture.captureDocument({...})  [leaf]
              docId = sha256(text); if documentExists → skip
              chunkText(text) → buildDocumentChunkRecords → capture each (chunk dedup)
         tally documents/chunks/duplicates
  └─ print FilesIngestResult
  (consolidation scheduler later promotes chunks into the searchable graph)
```

## 8. Testing strategy (suite stays green offline, no creds/network)

- **leaf `chunk.test.ts`:** empty; sub-target single chunk; exact multiples; overlap
  correctness; oversize single paragraph (sentence/word/hard fallbacks); determinism;
  unicode; `minChars` tail merge.
- **leaf `document.test.ts`:** record shape; `dedup_key` stability + per-chunk
  uniqueness; `doc_id` grouping; `chunk_index`/`chunk_count`; title prefixing; entity
  derivation.
- **leaf `capture` test:** `captureDocument` skip path (fake store `documentExists`),
  insert tally, chunk dedup on re-capture.
- **core `filesIngest.test.ts`:** temp-dir fixtures (txt/md), walk/skip/size-cap/empty;
  duplicate skip via fake `memory.capture`; injected **fake extractor** for the PDF
  branch (no binary fixture needed for the gate).
- **core (optional, tagged) integration:** real `unpdf` against one tiny committed PDF.
- Run `@jarvis/memory` then `@jarvis/core` tests (core depends on memory).

## 9. Phased implementation plan

**Phase 1 — Leaf chunker + document adapter (pure, TDD).**
Files: `services/memory/src/capture/chunk.ts`, `.../adapters/document.ts`,
`capture.ts` (`captureDocument`), `store/memoryStore.ts` (`documentExists` +
schema decision), `types.ts` (`"files"`, `"document"`), `index.ts` (expose),
`testing/fakes.ts` (extend fake store). Tests: `chunk.test.ts`, `document.test.ts`,
capture test. Gate: `npm test --workspace @jarvis/memory`.

**Phase 2 — Core extraction + ingest + CLI.**
Files: `services/core/src/memory/extractText.ts` (unpdf + passthrough),
`.../memory/filesIngest.ts`, `cli/connect.ts` (`syncFiles`, dispatch, help,
`JARVIS_FILES_DIR`), `services/core/package.json` (+`unpdf`). Tests:
`filesIngest.test.ts` with fake extractor. Gate: `npm test --workspace @jarvis/core`.
Manual: `npm run connect -- sync files <dir>` → `POST /consolidate` → query
`/api/memory?q=...` shows chunk recall.

**Phase 3 — Retrofit chunking to long captures (the cross-cutting win). ✅ DONE.**
`captureMarkdown` now chunks notes whose body exceeds the ~2048-char defer threshold
into multiple title-prefixed `obsidian`/`note` records (per-chunk dedup, shared
`doc_id`); shorter notes stay single records (byte-identical — no re-capture churn).
Return widened to `{ inserted, total, insertedCount }` (back-compatible —
`runVaultIngest` still keys off the `inserted` boolean); `buildMarkdownRecords` added
to the adapter + public exports. Long *external* records (calendar/digests) remain
single-record — a small optional follow-on.

**Phase 4 (optional) — Dashboard surfacing.**
Allowlist `"files"` in `/api/connectors/sync` (env-default path) + `ConnectorPanel`
control. Surface a path input or rely on `JARVIS_FILES_DIR`.

**Phase 5 (optional follow-on) — More formats.** `.docx` (`mammoth`), `.html`
(readability), `.rtf`. Same extractor seam; no new architecture.

## 10. Risks & mitigations

- **PDF lib weight / native deps** → `unpdf` is pure-JS/ESM/offline; isolated to core;
  extraction is injectable so the test gate never depends on it.
- **Edited-doc chunk churn** → tier-1 doc skip prevents churn on unchanged files;
  changed files re-chunk by design (bi-temporal journal + consolidation reconcile).
- **Consolidation load from chunk volume** → batched/HF; expected by design; size cap
  and `minChars` bound record counts.
- **`payload.doc_id` query cost** → JSON1 `json_extract` is builtin; add a nullable
  indexed `doc_id` column only if profiling warrants (decided Phase 1).
- **Boundary-shift dedup instability** → deterministic chunker keeps boundaries stable
  for unchanged text; verified by a determinism test.

## 11. Open decisions (resolve in Phase 1)

- `documentExists` via `json_extract` vs. a dedicated indexed `doc_id` column.
- Whether `page` is worth threading from `unpdf` per chunk in v1 (nice-to-have).
- Default `targetChars`/`overlapChars` (start 1200/150; tune against real recall).
