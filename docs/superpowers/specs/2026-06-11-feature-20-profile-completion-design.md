# Feature 20 completion — Personal Profile & Preference Learning

**Date:** 2026-06-11
**Status:** Approved (user pre-authorized build; workflow prefs: no review gates)
**Spec of record:** `features/20-personal-profile-and-preference-learning.md`

## Context

Feature 20 is ~60% built. Existing and verified working:

- `ProfileService` (`services/memory/src/profile/profile.ts`): facet derivation
  (preferences / people / projects / routines / communication style) from live
  semantic facts, `correctFact` (bi-temporal invalidate + insert), `editFacet`,
  `forgetEntity`, procedural-block passthrough.
- Procedural block: `procedural_block` singleton table, written by consolidation
  Stage 7 (`consolidation/procedural.ts`), injected near the top of the chat
  system prompt (`services/core/src/chat/promptAssembler.ts`).
- Dashboard: `/profile` page + `/api/profile` GET/PATCH/DELETE with
  correct/forget affordances (`apps/dashboard/app/components/ProfileView.tsx`).
- Facade: `MemorySystem.profile` wired in `createMemorySystem()`.

## Gaps this design closes

| # | Gap | Spec requirement |
|---|-----|-----------------|
| 1 | `pinned` is hardcoded `false`, never persisted; consolidation can overwrite confirmed facts | "confirmed (pin it so consolidation won't overwrite)"; "Pinned/confirmed facts are never silently overwritten" |
| 2 | Profile facets never injected into chat (only procedural block is) | "expose both to chat (feature 2)…"; "top-N salient facets relevant to the query, not the whole profile" |
| 3 | Agent loop has zero user-profile context | "…and the agent loop (feature 5)" |
| 4 | Conflicting facets not detected or surfaced | "keep both with timestamps and surface the conflict in the UI… more recent + higher-confidence wins for injection" |
| 5 | Test gaps: `editFacet`, `forgetEntity` | — |

## Design

### 1. Pin persistence + enforcement

**Storage:** new `pinned INTEGER NOT NULL DEFAULT 0` column on `facts`.
`applySchema()` gains an idempotent migration step (check `PRAGMA
table_info(facts)`, `ALTER TABLE … ADD COLUMN` if missing). A column was chosen
over a side-table so the pin rides the fact's bi-temporal lifecycle (no joins,
no orphaned pins when facts are invalidated).

**Store API** (`memoryStore.ts`):
- `Fact.pinned: boolean`, `FactInput.pinned?: boolean`; `rowToFact` maps it.
- `setFactPinned(factId, pinned): Fact | null` — deterministic, instant.

**Semantics:**
- A pin applies to the live fact. User corrections (`correctFact`) insert the
  replacement fact **born pinned** (user input is authoritative).
- An explicit user action (correct / forget / unpin) always overrides a pin —
  "never overwritten" guards against *consolidation*, not the user.

**Enforcement points (consolidation):**
- `resolveFact` (`consolidation/contradictions.ts`): if the live prior is
  pinned, prior wins unconditionally (skips trust/recency/AI tie-break). The
  incoming fact is still recorded as historical (closed interval, same as the
  existing "prior wins" branch) and the result is conflict-flagged so the run
  reports it.
- `computeForgetDecisions` (`consolidation/forget.ts`): pinned ⇒ `keep`,
  `protectedByFloor: true`, reason "pinned by user". Pinned facts are also
  excluded from compression groups.

**ProfileService:** derivation maps `pinned` from the fact (no more hardcoded
`false`); facet anchor selection prefers pinned facts. New
`setPinned(factId, pinned)` → `store.setFactPinned` + re-derive. `editFacet`
with a `pinned` update delegates to `setPinned` (persisted, not cache-only).

### 2. Salient facet injection into chat (`inject.ts`)

New `services/memory/src/profile/inject.ts` — fully deterministic (the spec
forbids inline AI on the chat path):

```ts
buildProfileContext(profile: PersonalProfile, query: string, opts?: {
  maxFacets?: number;   // default 5
  maxChars?: number;    // default 600
}): string              // "" when nothing qualifies
```

- **Scoring:** `relevance × (0.5 + 0.5·confidence) × recencyFactor`, where
  relevance = normalized token overlap between query tokens and facet text
  (value + names + predicate words). Pinned facts get a fixed boost.
- **Relevance-first with a small floor:** facets with relevance > 0 fill up to
  `maxFacets`; if none are relevant, fall back to at most 3 highest
  (pinned-then-confidence-then-recency) so chat keeps minimal personalization
  without locking into a stale self-image (over-personalization guard).
- **Conflict-aware:** within a conflict group only the winner (pinned >
  recency > confidence) is eligible.
- **Output:** compact markdown block (`## About the user` + bullets), capped.

**Derivation for injection** must not call the LLM: `deriveProfile` gains an
internal deterministic mode (skip person-note LLM summaries — fallback join is
used). `ProfileService.getProfileContext(query)` = deterministic derive +
`buildProfileContext`. Single-user SQLite store reads are cheap; no caching
staleness to manage.

**Chat wiring** (`services/core`):
- `MemorySystem.profile.getProfileContext(query)` consumed by `ChatCore.send`
  alongside the existing procedural-block load (try/catch → `""`).
- `assemblePrompt` gains `profileContext?: string`; rendered in the system
  block directly under `## How I work`. New `capProfile()` in
  `contextBudget.ts` mirrors `capProcedural()`; budget breakdown gains a
  `profile` entry.

### 3. Agent user-context provider

`@jarvis/agent` stays a leaf — inject, don't import:

- `AgentSystemConfig.userContext?: () => string | Promise<string>`.
- `AgentRunner` (and the Scheduler's runner path) resolve it once per run
  (try/catch → `""`, length-capped) and the ReAct loop prepends
  `User context:\n…` to its goal prompt.
- Core (`agentSystem.ts`) wires it to
  `memory.profile.getProfileContext(goal)` when a memory system is available;
  omitted otherwise (config stays optional — existing tests unaffected).

### 4. Conflict detection + surfacing

- `deriveProfile` groups live facts by `(subjectId, predicate)`; >1 live fact
  with differing values ⇒ every facet in the group gets
  `conflictsWith: string[]` (the other fact ids). `ProfileFact` and the
  dashboard `ProfileFactContract` gain the optional field.
- Dashboard `FactCard` shows a "conflict" badge; the user resolves with the
  existing "This is wrong" / forget affordances (per spec: surface, don't
  silently pick — injection picks the winner, the UI shows both).

### 5. Dashboard pin/confirm

- `PATCH /api/profile` accepts either `{ factId, correction }` (existing) or
  `{ factId, pinned: boolean }` (new → `ProfileService.setPinned`).
- `FactCard` gains a Confirm (pin) / Unpin toggle; pinned badge already exists.

## Deterministic vs AI boundary (unchanged from spec)

Everything in this design is deterministic: pins, injection selection, conflict
detection, corrections. AI stays where it was — consolidation-time extraction,
tie-breaks, procedural-block writing, optional person-note summaries (now
skipped on the injection path).

## Testing

Fake-driven, no network/models, per repo invariants:

- **memory:** pin migration idempotency; `setFactPinned`; corrections born
  pinned; `resolveFact` with pinned prior (wins + conflict flag + incoming
  recorded historical); forget/compression skip pinned; conflict detection in
  `deriveProfile`; `inject.ts` (relevance ranking, conflict winner, pinned
  boost, caps, empty-profile ⇒ ""; fallback floor); `editFacet` persistence;
  `forgetEntity`.
- **core:** `assemblePrompt` renders + budgets the profile block (and omits it
  when empty); `ChatCore` passes query-derived profile context (fake memory);
  degraded path when profile throws.
- **agent:** `userContext` provider output appears in ReAct prompt; absent
  provider ⇒ unchanged prompt; provider throwing ⇒ run proceeds without it.
- **dashboard:** `tsc --noEmit` (no vitest in dashboard, per repo convention).

## Out of scope

- Style LoRA (explicitly not v1 in the feature spec).
- Core HTTP profile endpoints (dashboard BFF reads SQLite directly — existing
  pattern; todo-style write delegation isn't needed since profile writes don't
  touch credentials).
- Embedding-based facet relevance (token overlap suffices at this scale; the
  swap point is isolated in `inject.ts` scoring).

## Alternatives considered

- **Pins in a side-table:** avoids ALTER TABLE but every read needs a join and
  pins can orphan; rejected.
- **Always-inject a static profile digest:** simpler but violates the spec's
  query-relevance requirement and risks over-personalization; rejected.
- **Embedding relevance for injection:** per-turn embed call adds latency for
  a handful of facets; rejected (YAGNI, swap point marked).
