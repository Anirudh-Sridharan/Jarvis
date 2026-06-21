# Gmail Email-Body Capture (second-brain capture breadth #3)

- **Date:** 2026-06-21
- **Status:** Implemented, tested & independently verified (Phases 1–2). `@jarvis/memory` 229 green, `@jarvis/core` 201 green, `@jarvis/integrations` 238 green, dashboard `tsc` clean. Verified against the live Gmail API via MCP (default query valid + scope-correct; real messages carry a `plaintextBody`). `parseAddresses` hardened for malformed headers (quote-aware comma split; `@`-validated angle tokens). Phase 3 (dashboard surfacing / incremental cursor) remains an optional follow-on. Approved scope: Inbox + Sent, excl. promo/social, CLI-only v1.

  **Live caveat (from MCP grounding):** on accounts where Gmail does not classify bulk senders into the Promotions/Social tabs, those mails still pass the default filter and get captured — the `JARVIS_EMAIL_QUERY` override + consolidation forgetting are the mitigations. With 30-day volume above `maxResults` (100), one pass captures the most-recent 100; full backfill awaits the Phase-3 pagination cursor.
- **Feature:** Capture-breadth connector #3 — email bodies (`source: "gmail"`, `type: "email"`)
- **Builds on:** Local-documents/PDF ingest (`docs/.../2026-06-20-local-documents-pdf-ingest-design.md`), the reusable chunking layer (`services/memory/src/capture/chunk.ts`), the live Gmail REST layer (`services/integrations/src/connectors/gmailActions.ts`).
- **Theme:** second-brain repositioning → capture breadth. The local-docs spec named email bodies as the **explicit follow-up lever**.

## 1. Summary

Add an **email-body capture connector** that pulls recent Gmail messages (Inbox +
Sent, excluding Promotions/Social/Spam/Trash by default), extracts each message's
plain-text body, **chunks long bodies into retrievable passages** (reusing the
existing chunker), and captures each chunk as a dedup-aware `ExperienceRecord`. It
mirrors the Obsidian and local-documents connectors exactly: **live fetch on core,
parse/chunk on the leaf**, CLI-driven, idempotent. After consolidation, your real
correspondence becomes recallable — not just email *counts*.

## 2. Motivation

The memory graph today ingests chat turns, calendar events, health/work *digests*,
Gmail **counts** (`gmail.received`/`gmail.sent` metrics — not content), the Obsidian
vault, and local documents/PDFs. It does **not** ingest email *bodies*. The
local-documents spec (§2, §3) recorded email backfill as "the follow-up lever."
Personal and work correspondence is among the highest-signal records of what you
discussed, decided, and committed to — the cleanest next increment of "capture
everything."

The live Gmail read path already exists for the agent's `email_search`/`email_get`
tools (`gmailActions.ts`): `getEmailThread` returns each message's decoded
`text/plain` body. We reuse it as the capture source — **no new Gmail transport**.

### Privacy stance (intentional, reconciled)

`gmailActions.ts` documents that it returns bodies "transiently, NEVER persisted by
this module." That contract is about the **agent-tool transport** and stays
unchanged. This connector **deliberately persists** bodies into the **local**
memory store under the locked **capture-everything** decision — data never leaves
the machine (local SQLite, local embeddings). The two paths are separate; we do not
weaken the transport's transient contract.

## 3. Scope

**In (v1):**
- Default query: `(in:inbox OR in:sent) -category:promotions -category:social -in:spam -in:trash newer_than:30d`.
- Override via `JARVIS_EMAIL_QUERY` (full Gmail query string).
- `text/plain` bodies only (HTML-only mail → empty body → skipped + logged).
- One `ExperienceRecord` per chunk; short emails = one record.
- CLI: `npm run connect -- sync email`.
- Idempotent re-scan via per-chunk `UNIQUE(dedup_key)` (emails are immutable).

**Out (deferred, explicitly):**
- Dashboard surfacing (optional Phase 4 follow-on; v1 is CLI-only, matching how
  Obsidian shipped — avoids a confusing "two Gmail buttons" UX where one syncs
  counts and one syncs bodies).
- Incremental cursor (re-runs re-fetch the bounded query window and dedup; a
  `gmail-email` sync cursor is a later optimization).
- HTML→text extraction, attachments (the transport is `text/plain`-only today).
- Thread-level summarization (consolidation's REFLECT already synthesizes across
  the per-message records sharing a `thread_id`).

## 4. Architecture (the seam we extend)

| Concern | Lives in | Reference / new |
|---|---|---|
| Fetch recent emails + bodies | **core** (live) | reuse `integrations.email.{search,getThread}` |
| Walk hits → capture | **core** (live) | **new** `services/core/src/memory/emailIngest.ts` |
| Parse → chunk → `ExperienceRecord[]` | **leaf** `@jarvis/memory` (pure) | **new** `services/memory/src/capture/adapters/email.ts` |
| Capture pipeline (dedup→journal→embed) | leaf | unchanged `capture.ts` (new `captureEmail`) |
| `SourceId`/`ExperienceType` unions | leaf | already include `"gmail"`/`"email"` |
| CLI sync dispatch | core | `services/core/src/cli/connect.ts` (new `syncEmail`) |
| Consolidation (promote → graph) | leaf | unchanged — consumes `consolidation_pending` |

The leaf rule holds: the leaf never touches the network; the chunker/adapter are
pure and unit-testable offline. Core fetches; leaf parses.

## 5. Design

### 5.1 Data model — chunks-only (mirrors `document`)

One chunk → one `ExperienceRecord`; messages sharing a `thread_id` are grouped by
payload, not a parent record (preserves the single-vector-per-record store and the
"retrieval returns whole records" contract).

Per-chunk record:
- `source: "gmail"`, `type: "email"`, `actor: "user"`, `via: "in_process"`.
- `text`: a self-describing header prefix + chunk body, so each chunk embeds well:
  ```
  ${subject}
  From: ${from} · To: ${to} · ${date}

  ${chunkBody}
  ```
- `payload`: `{ message_id, thread_id, from, to, subject, date, doc_id, chunk_index, chunk_count, char_start, char_end }`.
- `entities`: people parsed from `from`/`to` headers — `{kind:"person", value:<display name>}` when present, plus `{kind:"email", value:<addr>}`; deduped.
- `nativeId`: `${message_id}#${chunk_index}` → `raw_ref = raw/gmail/<nativeId>.json`,
  `dedup_key = computeDedupKey("gmail", nativeId, chunkBody)`.
- `doc_id = message_id` — emails are immutable, so the message id is a stable,
  globally-unique grouping key (no sha256-of-text needed as for editable files).
- `timestamp`: the message `date` parsed to ISO (fallback: now).

### 5.2 Idempotency — chunk-level only

Emails are immutable: a captured message never changes. So the doc-level fast-skip
that the *files* connector added (to avoid re-chunking **editable** documents) is
unnecessary here. The existing `insertExperienceIfNew` `UNIQUE(dedup_key)` is the
sole, sufficient dedup: re-running the query window re-chunks already-seen messages
and they drop at insert. (`documentExists` is `source='files'`-scoped and is **not**
touched.) Cost of a re-run is dominated by the `getThread` fetches, which a later
incremental cursor can elide; chunking is pure-JS and cheap.

### 5.3 Live fetch (`runEmailIngest`, core, injectable source)

`search` returns metadata hits (no body); `getThread` returns bodies for **all**
messages in a thread. We dedup thread ids, fetch each thread once, and capture
**only** the messages whose id is in the matched hit set — so the user's scope
choice is honored precisely (a promotional reply inside a matched thread is not
pulled in).

```
runEmailIngest({ memory, email, query?, maxResults?, now? }):
  q   = query ?? JARVIS_EMAIL_QUERY ?? DEFAULT_QUERY
  hits = await email.search(q, maxResults ?? 100)        // [{messageId, threadId, ...}]
  wanted = Set(hits.messageId)
  for threadId of unique(hits.threadId):
    let thread; try { thread = await email.getThread(threadId) } catch { errors++; continue }
    for msg of thread.messages where wanted.has(msg.id):
      if !msg.body.trim(): skipped++; continue
      { inserted, total } = await memory.capture.captureEmail({
          messageId: msg.id, threadId, from: msg.from, to: msg.to,
          subject: msg.subject, date: msg.date, body: msg.body })
      messages++; chunks += inserted; duplicates += (total - inserted)
  return { scanned: hits.length, messages, chunks, duplicates, skipped, errors }
```

`EmailSource` is an injected interface (`Pick<IntegrationsSystem["email"], "search" | "getThread">`),
default = the live `integrations.email`, so core tests use a fake and stay hermetic
(no network/creds). `DEFAULT_QUERY` is the §3 string (Gmail's `newer_than:30d` is
server-relative — deterministic, no clock needed).

### 5.4 Leaf adapter (`buildEmailRecords`, pure)

```ts
buildEmailRecords(opts: {
  messageId: string; threadId: string;
  from: string; to: string; subject: string; date: string; body: string;
  chunkOpts?: ChunkOptions;
}): ExperienceRecord[]
```
- `chunkText(body)` → chunks (short body = 1 chunk; empty/whitespace body → `[]`).
- header-prefix each chunk's `text`; build payload/entities/dedup per §5.1.
- `parseAddresses(header)` → `{name?, email}[]` with a dependency-free regex
  (handles `Name <a@b.com>`, bare `a@b.com`, comma lists); → person/email entities.
- `timestamp`: `Date.parse(date)` → ISO; `NaN` → `new Date().toISOString()`.

### 5.5 Capture method (`captureEmail`, leaf)

```ts
captureEmail(opts): Promise<{ inserted: number; total: number }> {
  const records = buildEmailRecords(opts);
  let inserted = 0;
  for (const r of records) if ((await this.capture(r)).inserted) inserted++;
  return { inserted, total: records.length };
}
```
Exposed on `MemorySystem.capture`. Each chunk ≤ ~1200 chars < the 2048 defer
threshold → embedded immediately (no deferred giant blobs).

### 5.6 CLI wiring (`connect.ts`)

`sync email` → `syncEmail()`: build live integrations (gives `system.email` bound
to the real http/Keychain token store) + the memory system, then
`runEmailIngest({ memory, email: system.email })`. Print
`{ scanned, messages, chunks, duplicates, skipped, errors }` + the consolidation
hint. Requires Gmail consent (`npm run connect -- gmail`); a missing-token error
prints the re-consent hint (existing `printRun`-style guidance).

`email` is dispatched **before** the `SYNCABLE_SOURCES` check (like `obsidian`,
`files`, `simplefin`) — it is filesystem/in-process capture, not an OAuth metric
sync, and must not collide with `sync gmail` (which keeps syncing counts).

## 6. Testing strategy (suite stays green offline — no creds/network)

- **leaf `email.test.ts`:** record shape & header prefix; `dedup_key` stability +
  per-chunk uniqueness on a long body; `doc_id` = messageId grouping;
  `chunk_index`/`chunk_count`; `parseAddresses` (`Name <a@b>`, bare addr, comma
  list, empty); empty/whitespace body → `[]`; long body chunked (>1 record);
  `timestamp` parse + NaN fallback determinism.
- **leaf capture test:** `captureEmail` insert tally; chunk dedup on re-capture
  (second call inserts 0).
- **core `emailIngest.test.ts`** (fake `EmailSource`): thread dedup (`getThread`
  called once per thread even with 2 matched messages in it); capture only matched
  message ids (a non-matched message in a fetched thread is skipped); empty-body
  skip; `getThread` throws → `errors++`, loop continues; duplicate tally on re-run;
  default query used when none supplied; `query` override forwarded to `search`;
  result-envelope counts correct.

Run order: `@jarvis/memory` then `@jarvis/core` (core depends on memory).
Gates: `npm test --workspace @jarvis/memory`, `npm test --workspace @jarvis/core`.

## 7. Phased implementation plan

**Phase 1 — Leaf email adapter + `captureEmail` (pure, TDD).**
Files: `services/memory/src/capture/adapters/email.ts` (new),
`capture.ts` (`captureEmail`), `index.ts` (export `buildEmailRecords`),
`testing/fakes.ts` (extend fake `MemorySystem.capture` with `captureEmail` if the
fake enumerates methods). Tests: `email.test.ts`, capture test.
Gate: `npm test --workspace @jarvis/memory`.

**Phase 2 — Core ingest + CLI.**
Files: `services/core/src/memory/emailIngest.ts` (new),
`cli/connect.ts` (`syncEmail`, dispatch, help, `JARVIS_EMAIL_QUERY`).
Tests: `emailIngest.test.ts` with fake `EmailSource`.
Gate: `npm test --workspace @jarvis/core`.
Manual: `npm run connect -- sync email` → `POST /consolidate` → `/api/memory?q=…`
shows email recall.

**Phase 3 (optional follow-on) — Dashboard surfacing / incremental cursor.**
A dashboard card and a persisted `gmail-email` sync cursor are deferred.

## 8. Risks & mitigations

- **Body persistence vs. the transport's transient contract** → reconciled in §2:
  separate path; local-only; capture-everything is the locked decision.
- **Capture noise** → default query excludes promotions/social/spam/trash; full
  override via `JARVIS_EMAIL_QUERY`; consolidation forgets low-value records.
- **Re-run cost (getThread per thread)** → bounded by the query window +
  `maxResults`; correctness via chunk dedup; incremental cursor is a noted
  follow-on.
- **HTML-only mail** → empty `text/plain` → skipped + logged (not an error),
  mirroring scanned-PDF handling.
- **Consolidation load from volume** → batched/HF, expected by the capture-
  everything design; `maxResults` and the category filters bound record counts.

## 9. Open decisions (resolved)

- Capture scope: **Inbox + Sent, excl. promotions/social/spam/trash** (user-chosen).
- Window: **30 days** default, `JARVIS_EMAIL_QUERY` override.
- Dedup: **chunk-level only** (emails immutable; no doc-level fast-skip).
- `doc_id`: **message id** (stable; no text hash needed).
