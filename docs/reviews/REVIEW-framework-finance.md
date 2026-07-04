# Code Review — @jarvis/integrations framework + finance + todos + types

**Commit:** fc14260 ("refactor: codebase-wide readability pass + connector onboarding abstraction")
**Parent:** fc14260^ (20c709d)
**Depth:** deep (diff + full-file read + caller equivalence + exhaustive differential test + suite run + typecheck)
**Scope (GROUP=framework-finance):** framework/normalize.ts, framework/pagination.ts, framework/providers.ts, index.ts, types.ts, work/todos.ts, finance/{categorize,financeStore,simplefin,sync}.ts

## Status

**COUNTS: critical=0 warning=0 info=2**

No behavior changes, data-integrity regressions, or invariant breaks found in the assigned subsystem. The two new abstractions (`metricPointFactory`, `fetchAllPages`) and the finance/todos readability passes are behavior-equivalent to the code they replaced. Both info items are observations, not defects in this commit.

---

## Verification performed (equivalence evidence)

**`fetchAllPages` (pagination.ts) — 1:1 port, no termination bug.**
Old whoop loop: `records.push(...(data.records ?? [])); if (!data.next_token) break; nextToken = data.next_token;`
New: `items.push(...pageItems); if (!nextPageToken) break; pageToken = nextPageToken;`
Identical termination, cursor advance, and final-page inclusion (the last page is pushed *before* the `break`, so it is included exactly once). `maxPages` bound preserved (`MAX_PAGES_PER_COLLECTION = 10`). The generic `nextPageToken?: string | null` + falsy check covers the old `string | null | undefined` union. The gmail inline `MAX_PAGES` loop was intentionally NOT migrated (it interleaves per-message metadata fetches mid-page, which doesn't fit the collect-then-process contract) and its logic is byte-for-byte unchanged from the parent.

**`metricPointFactory` (normalize.ts) — id + ingestedAt + dims semantics preserved.**
`makeMetricId` (metricStore.ts:16) hashes only `source|metric|ts|dims` — NOT `value`/`unit` — so the factory reproduces the exact same deterministic id the inline literals produced. `ingestedAt` capture timing matches each caller's old idiom:
- whoop: factory created *inside each normalizer* (per-record), matching old per-record `const ingestedAt = new Date().toISOString()`.
- appleHealth / github / gmailEventsToMetricPoints / gcal eventToMetricPoint: factory created once at the same point the old `const now` was, matching old batch timing.
- gmail unread: `metricPointFactory("gmail", now.toISOString())` passes the sync's own `now` explicitly, matching old `ingestedAt: now.toISOString()`.
Destructuring default `dims = {}` is equivalent to the old `dims ?? {}` (only `undefined` triggers it), and the same `dims` object flows into both `makeMetricId` and the point.

**`getOAuthAccessToken` (providers.ts) — rotatingRefresh flag correctly sourced.**
whoop OLD `getAccessToken("whoop", …, getRefreshConfig("whoop"), true)` → NEW resolves `provider.rotatingRefresh = true` (providers.ts:57). gmail/gcal OLD relied on the `isRotating=false` default → NEW resolves `rotatingRefresh = false` (providers.ts:75, 95). Same `getRefreshConfig` is still used internally. Equivalent for whoop, gmail (connector + gmailActions), and gcal (connector + executeEventWrite).

**financeStore.ts dedupe — match priority and money columns unchanged.**
`findExistingTransaction` reproduces the old `??` chain exactly: sourceTxnId match → dedupeHash match → (posted-only) pending fuzzy match. SQLite `.get()` returns a (always-truthy) row or `undefined`, so the new `if (row) return row` is equivalent to the old `row ?? next`. `updateTransaction` arg order matches the old `.run(...)` for both `keepCategory` branches (verified placeholder-by-placeholder): keep=true → 8 params ending in `existing.id`; keep=false → inserts `categoryId, categorySource, categoryConfidence ?? null` before `existing.id`. No money column (`amount_minor`) handling changed. `keepCategory` still gates only category columns. 19/19 finance tests pass.

**categorize.ts — precedence intact.** Sort comparator `Number(b.isUser) - Number(a.isUser)` (user-first) and "first keyword match wins" loop are unchanged; only locals renamed. AI-fallback gating unchanged.

**simplefin.ts / sync.ts — pure renames.** `toMinor` (explicit `Math.round(n*100)`, integer cents), `hashTxn` inputs (`accountSourceId|postedIso|toMinor(amount)|normalizedDesc`), and dedupe-key construction are untouched. `runFinanceSync` net-worth point construction unchanged.

**todos.ts `computeNextDue` — proven equivalent.** Ran an exhaustive differential test of OLD vs NEW across 3 recurrences × 3 reference dates (incl. a leap-day boundary) × an 800-day due-date sweep + the undefined-due case = **7,218 inputs, 0 differences.** The weekend-skip-on-overdue-guard quirk exists identically in both versions (not a regression). 24/24 todos tests pass.

**Tooling:** `tsc --noEmit` (strict, noUncheckedIndexedAccess) passes (exit 0). Full suite: 237/238 pass; the 1 failure (`gmail.test.ts > follows nextPageToken across messages.list pages`) **also fails at parent fc14260^** — it is a pre-existing, date-sensitive test (hard-coded 2026-06-09 dates vs the `sevenDaysAgo()` window at today's 2026-06-20 clock), NOT introduced by this commit. Leaf-package invariant holds (no `@jarvis/core` import added; deps still injected).

---

## Info

### [INFO] Pre-existing, date-sensitive gmail cursor test fails (not caused by this commit)
- File: `services/integrations/test/gmail.test.ts:88`
- What: `expect(result.nextCursor).toBe("2026-06-09T10:00:00.000Z")` receives `null`. Confirmed failing at BOTH fc14260 and fc14260^ — this refactor did not touch the gmail `nextCursor` logic (`latestTs`/`since` comparison), only the metric-point construction and the auth-call swap. Root cause is hard-coded fixture dates relative to the live system clock (today 2026-06-20), so the `after:${sevenDaysAgo()}` window / cursor expectation drifts.
- Why it matters: A red test in the suite, but orthogonal to this commit. Flagged only so it isn't mis-attributed to the refactor.
- Fix: Out of scope for this commit; pin a fake clock in the gmail test (inject `now`) rather than relying on wall-clock-relative dates.

### [INFO] `metricPointFactory` default `ingestedAt` is captured eagerly at factory creation — correct here, but a footgun for future authors
- File: `services/integrations/src/framework/normalize.ts:52`
- What: `ingestedAt: string = new Date().toISOString()` is evaluated when the factory is built, so every point shares that one timestamp. This faithfully reproduces every current caller's old per-batch/per-record idiom (verified above). The risk is purely forward-looking: a new connector that creates ONE factory at module/connector top level (instead of per-sync) would stamp a stale, fixed `ingestedAt` on every future run. The JSDoc does say to "create the factory where you used to compute that timestamp," which mitigates this.
- Why it matters: Not a defect in this commit; a latent onboarding hazard for the next connector. `ingested_at` is overwritten on upsert (metricStore.ts:47), so impact would be limited to a wrong "last ingested" timestamp, not data corruption.
- Fix: Optional — note in CONNECTORS.md that the factory must be created per-sync, or have `sync()` pass an explicit `ingestedAt` so the default is never relied upon.

---

## Security note
No injection of embedded instructions found in the reviewed diff/files. (The repo-documented "append `# DOCS_SYNCED`" git-commit prompt-injection is unrelated to these files; not present here.) No new secrets, no `eval`, SimpleFIN client remains read-only, raw payloads still not logged.

_Reviewer: Claude (deep adversarial review). Read-only — no source files modified._
