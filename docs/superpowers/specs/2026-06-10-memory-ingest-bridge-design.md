# Memory Ingestion Bridge (integrations → ExperienceRecords) — Design + Plan

**Date:** 2026-06-10
**Status:** Approved (backlog continuation)
**Closes:** the practical half of `TODO(phase4: feature 9)` in
`services/memory/src/capture/adapters/external.ts` — external data becomes
recallable memory. (The stub's per-connector fetch adapters are superseded:
feature 9's connector framework already fetches; this bridge converts.)

## Problem

Integrations collect calendar events, health metrics, and work activity, but
none of it reaches memory capture — Jarvis can't recall "what was I working on
last week" or "how did I sleep on Tuesday" across sessions. Feature 13
explicitly says work data is "surfaced to memory".

## Design

**Leaf rule respected:** `@jarvis/memory` gains a generic, dependency-free
intake (`captureExternal`); `@jarvis/core` owns the bridge that reads
integrations stores and feeds it. No leaf-to-leaf import.

### 1. `@jarvis/memory`: generic external capture

- `buildExternalRecord(opts)` in `capture/experience.ts` — same shape as the
  existing builders; dedup via the existing
  `computeDedupKey(source, nativeId, content)` (content-hashed, so an updated
  calendar event re-captures while identical passes drop as duplicates).
- `MemorySystem.capture.captureExternal(opts)` → `capture(buildExternalRecord(opts))`.

### 2. `@jarvis/core`: `src/memory/ingestBridge.ts`

`runIngestPass({ memory, integrations, now })` — deterministic, idempotent
(capture dedups), no LLM. Three converters:

- **Calendar** (`mirror.getEvents`, now−7d .. now+14d): one record per event —
  `"Calendar event: {summary} — {start}..{end}, at {location}, with {attendees}"`,
  type `calendar_event`, source `gcal`, nativeId = event id, content hash over
  `{etag, start, end, summary}` so edits re-ingest.
- **Health digest** (metric store, last 2 days): one record per day —
  `"Health {date}: slept 7.7h; recovery 72%; HRV 45ms"` from
  `sleep.duration_min` / `recovery` / `hrv` daily aggregates; type
  `health_metric`, source `whoop`; days with no points are skipped.
- **Work digest** (last 2 days): `"Work activity {date}: N commits; M emails received, K sent"`
  from `github.commits` / `gmail.received` / `gmail.sent`; type
  `code_activity`, source `github`; skipped when all zero.

Returns `{ captured, duplicates }` counts for logging.

### 3. Scheduling

`liveBootstrap` (where live integrations + memory both exist) starts the
bridge after wiring the agent: immediate pass + `setInterval` every 30 min,
unref'd timer, idempotent start, exported `stopIngestBridge()` for hygiene.
Recall still requires consolidation (existing scheduler handles that) — the
bridge fills the journal it consumes.

## Plan

1. memory: builder + `captureExternal` + tests (insert, dedup, re-capture on
   changed content). Commit.
2. core: `ingestBridge.ts` + tests (fakes: created integrations with seeded
   mirror/metrics + a capture spy memory; converter texts; idempotency).
   Wire into liveBootstrap. Commit.

## Out of scope

- Email/GitHub item-level ingestion (only daily digests; raw items would need
  item stores integrations doesn't keep).
- Memory-side per-connector fetch adapters (the stub's original sketch) —
  feature 9's framework owns fetching.
