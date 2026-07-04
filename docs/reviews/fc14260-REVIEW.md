---
status: clean
commit: fc14260
commit_subject: "refactor: codebase-wide readability pass + connector onboarding abstraction"
depth: deep
review_method: 5 parallel gsd-code-reviewer agents (by subsystem) + full test/typecheck run + diff verification
files_reviewed: 43
findings:
  critical: 0
  warning: 0
  info: 3
  total: 3
refactor_verdict: behavior-preserving
pre_existing_issues: 1   # gmail dated-fixture test failure — NOT caused by this commit
reviewed_at: 2026-06-20
---

# Code Review — `fc14260` (deep)

> **Verdict: `fc14260` is a genuine, behavior-preserving refactor.** Across all 43 changed
> files, five independent deep reviews found **zero refactor-introduced bugs** (0 critical,
> 0 warning). Every change is a mechanical extract-helper / rename-local / hoist-constant /
> swap-to-shared-abstraction, verified hunk-by-hunk against the parent (`fc14260^`) and
> corroborated by the test suite and a strict typecheck.
>
> The only red test on the branch (`gmail.test.ts`) is **pre-existing dated-fixture rot** —
> it fails identically on the parent commit and is unrelated to this refactor (see below).

## How this was reviewed

- **Scope:** the full `git diff fc14260^..fc14260` — 43 source files, +1534 / −1150.
- **Static:** 5 `gsd-code-reviewer` agents, one per subsystem, each told the prime directive
  for a refactor — *find where the "readability pass" silently changed behavior* — and to
  check against the documented project invariants (bi-temporal/no-hard-delete, agent safety,
  leaf-package purity, `node:sqlite`-only).
- **Dynamic:** full vitest run on every changed package + dashboard `tsc --noEmit`.
- **Verification:** the one contested point (Gmail cursor) was independently re-derived from
  the diff and root-caused, not taken on trust.

### Per-subsystem result

| Subsystem | Files | Critical | Warning | Info | Tests |
|---|---:|---:|---:|---:|---|
| memory (`memoryStore`, `forget`, `consolidation`, `contradictions`, `profile`) | 5 | 0 | 0 | 0 | 191 ✅ |
| core / agent / voice (`server.ts`, agent loop, scheduler, voice) | 7 | 0 | 0 | 1\* | 114 + 118 ✅ |
| connectors (Whoop/Gmail/GCal/GitHub/AppleHealth + briefing) | 8 | 0 | 0 | 1\* | (see ⚠ below) |
| framework + finance (`normalize`, `pagination`, finance store, todos, types) | 10 | 0 | 0 | 1 | 237 ✅ |
| dashboard (BFF route, `fetchEnvelope`, components, pages) | 13 | 0 | 0 | 2 | tsc clean ✅ |

\* The "info" items in core/agent/voice and connectors were non-findings (a prompt-injection
landmine acknowledgement and a CONNECTORS.md clean-bill); they are not reproduced below.
The 3 substantive info items follow.

## Verification scorecard

| Target | Result |
|---|---|
| `@jarvis/memory` | ✅ 191 passed |
| `@jarvis/integrations` | ⚠ 237 passed, **1 pre-existing failure** (Gmail dated fixture — also red on parent) |
| `@jarvis/agent` | ✅ 114 passed |
| `@jarvis/voice` | ✅ 118 passed |
| `@jarvis/core` | ✅ 185 passed |
| dashboard `tsc --noEmit` | ✅ clean |
| memory/agent/voice/core/integrations `tsc` (strict) | ✅ clean |

## Invariants explicitly re-verified as INTACT

- **Bi-temporal memory / no hard deletes:** `forget.ts` thresholds & comparisons unchanged;
  pinned facts still always classify "keep"; all removals are soft `invalidateFact` + INSERT;
  `valid_to` / `invalidated_at` / `pinned` SQL predicates and cosine math unchanged.
- **Profile corrections:** `correctFact` still invalidates-old + inserts-new; corrections
  still born pinned.
- **Agent safety:** the safety gate (reactLoop / approval / hash-chained audit / registry)
  was **not touched** by this commit; read-only default and approval escalation paths intact.
- **Voice barge-in:** confirmed-mode echo guard preserved (replies won't self-cancel).
- **Connector output identity:** `metricPointFactory` + `fetchAllPages` produce byte-identical
  `MetricPoint` ids (idempotency preserved); Whoop v2 endpoints/OAuth/pagination intact; the
  ~106 lines removed from `whoop.ts` were confirmed redundant/dead, not load-bearing.
- **Finance money handling:** `financeStore` dedupe match-priority and update arg-order
  preserved placeholder-by-placeholder; `toMinor` integer-cents rounding & `hashTxn` inputs
  unchanged. (`computeNextDue` validated by a 7,218-input old-vs-new differential — 0 diffs.)
- **Dashboard BFF boundary:** `fetchEnvelope` reproduces each inline helper exactly (including
  that the originals never checked `res.ok`, so no status check was lost); profile write
  boundary (bi-temporal corrections, XOR guards) untouched; no new write paths.
- **Leaf-package purity:** no `@jarvis/core` import introduced in any leaf package.

---

## Info findings (refactor-introduced, non-blocking)

### [INFO] `metricPointFactory` captures `ingestedAt` eagerly
- File: `services/integrations/src/framework/normalize.ts:52`
- What: the factory's default `ingestedAt` is captured **once when the factory is created**,
  not per-point. Correct for every current caller (each calls `metricPointFactory(...)` once
  per sync), so behavior is identical to the old inline `now` — verified.
- Why it matters: latent footgun. A future connector that creates the factory once at
  **module level** (instead of per-sync) would stamp every point with a frozen ingest time.
- Fix: either compute `ingestedAt` lazily inside the returned `point()` closure, or add a
  one-line doc comment that the factory must be created per-sync.

### [INFO] `server-only` not declared in dashboard `package.json`
- File: `apps/dashboard/app/lib/fetchEnvelope.ts:14`
- What: the new helper imports `server-only`, which isn't a declared dependency; it resolves
  only via Next's bundled copy. `tsc` + `next build` both pass today, and all 8 consumers are
  async Server Components, so the import is safe.
- Why it matters: fragility — a future dependency reshuffle could break the resolution.
- Fix: add `server-only` to `apps/dashboard/package.json` dependencies.

### [INFO] `toFactContract` generic drops the value↔fact type link
- File: `apps/dashboard/app/api/profile/route.ts:23`
- What: the extracted `toFactContract(fact: ProfileFact<unknown>, value: TOut)` no longer ties
  the fact's payload type to `value` at compile time. No live bug — every call site passes a
  matching fact.
- Why it matters: a future mismatched call wouldn't be caught by the compiler.
- Fix: parameterize as `toFactContract<T>(fact: ProfileFact<T>, value: T)` if you want the
  guard back.

---

## Pre-existing issue (NOT caused by `fc14260`)

### [WARNING — pre-existing] Gmail cursor test fails on a stale dated fixture
- File: `services/integrations/test/gmail.test.ts:88`
- What: `expect(result.nextCursor).toBe("2026-06-09T10:00:00.000Z")` returns `null`.
- Root cause: with `cursor=null`, the connector sets `since = sevenDaysAgo()` (`Date.now()-7d`).
  Live clock is **2026-06-20**, so `since` = 2026-06-13. The fixtures are dated **2026-06-09 /
  06-08** — now older than the 7-day window — so `latestTs` never advances past `since` and
  `nextCursor` is correctly `null`. The test was written when "now" was close to the fixtures.
- **Not a refactor regression:** the diff proves `gmail.ts`'s cursor + pagination logic
  (`since` / `latestTs` / `nextCursor` / `sevenDaysAgo` / `pageToken`) is **byte-identical** to
  the parent; two reviewers independently confirmed the test is red on `fc14260^` as well.
- Why it still matters: the suite is red on `main`, which masks future regressions.
- Fix (pick one): make the fixtures relative to the live clock (e.g.
  `Date.now() - 1*24*60*60*1000`) and assert against the computed value; **or** inject a fixed
  clock into the connector; **or** have the test seed a `cursor.highWater` older than the
  fixtures so `since` doesn't depend on wall-clock time.

---

## Detail reports
- `reviews/REVIEW-memory.md`
- `reviews/REVIEW-core-agent-voice.md`
- `reviews/REVIEW-connectors.md`
- `reviews/REVIEW-framework-finance.md`
- `reviews/REVIEW-dashboard.md`
- `reviews/_verify.log` — full test + typecheck output
