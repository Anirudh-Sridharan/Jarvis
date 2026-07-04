# Code Review — @jarvis/integrations connectors + briefing

**Commit:** fc14260 ("refactor: codebase-wide readability pass + connector onboarding abstraction")
**Parent:** fc14260^ (20c709d)
**Depth:** deep
**Scope (GROUP=connectors):** briefing.ts, appleHealth.ts, github.ts, gmail.ts, gmailActions.ts, googleCalendar.ts, whoop.ts, CONNECTORS.md
**Also read for equivalence verification:** framework/normalize.ts, framework/pagination.ts, framework/providers.ts, framework/oauth.ts, framework/metricStore.ts, index.ts, types.ts

## Status: PASS — refactor is behavior-preserving

**COUNTS: critical=0 warning=0 info=2**

The "connector onboarding abstraction" was verified hunk-by-hunk against the pre-refactor code. Every connector still produces the **same normalized output, same units, same timestamps, same metric ids, same endpoints, same auth, same pagination** as before. The three extracted helpers (`metricPointFactory`, `fetchAllPages`, `getOAuthAccessToken`) are provably equivalent to the inline code they replaced. No behavior change, no security regression, no leaf-package/HttpClient invariant break.

Test totals are identical to the parent commit (237 pass, 1 pre-existing fixture failure — see IN-01); the refactor introduced **zero** new failures.

---

## Equivalence verification (the #1 priority — silent behavior changes)

**`metricPointFactory(source, ingestedAt?)` ≡ old inline literal.** Verified `services/integrations/src/framework/normalize.ts:58-73`. The factory emits exactly the old 9-field literal: `id: makeMetricId({source, metric, ts, dims})`, `source`, `metric`, `value`, `unit`, `ts`, `dims` (default `{}`), `ingestedAt`, `adapterVersion: "1"`. Confirmed at runtime that `makeMetricId` returns a **byte-identical hash** for `dims: undefined` vs `dims: {}`, so the whoop-sleep change from `dims ?? {}` to passing `dims` straight into the factory preserves point ids → idempotent upsert behavior is intact. Distinct `dims` (e.g. `{stage:"light"}`) still yield distinct ids.
- `ingestedAt` batching semantics preserved: appleHealth/github/gmail-volume previously computed `const now` once at the top of the normalizer and shared it across all points; the factory captures `ingestedAt` once at factory-creation, called at the same spot → same single-timestamp-per-batch behavior. `gmail.unread_count` correctly forwards `now.toISOString()` as the override so its `ingestedAt` matches the pre-refactor value (`gmail.ts:110`). `eventToMetricPoint` created `now` per-call before and creates a factory per-call now → equivalent.

**`fetchAllPages(fetchPage, maxPages)` ≡ old whoop inline pager.** Verified `services/integrations/src/framework/pagination.ts:27-42` against old `whoop.ts` loop. Identical: same `for (page=0; page<maxPages; page++)`, same `items.push(...pageItems)`, same `if (!nextPageToken) break`, same MAX_PAGES_PER_COLLECTION=10 cap. The whoop adapter (`whoop.ts:84-104`) maps `{records, next_token}` → `{items, nextPageToken}` faithfully, keeps `start`/`limit=25`/`nextToken` query params, keeps the v2 endpoints, and keeps throw-on-non-200. **No dropped last page, no off-by-one, no infinite loop, no dropped pagination.**

**`getOAuthAccessToken("whoop"/"gcal"/"gmail", …)` ≡ old `getAccessToken(…, getRefreshConfig(…), isRotating)`.** Verified `providers.ts:168-181`. For whoop it derives `rotatingRefresh: true` from the catalog (`providers.ts:57`) and passes it to `getAccessToken`, exactly reproducing the old explicit `true` arg → the serialized rotating-refresh critical section and `scope=offline` re-send (`extraRefreshParams`, `providers.ts:58`) are preserved. gcal/gmail derive `false` → unchanged non-rotating path.

**Whoop v2 API intact.** `WHOOP_API_BASE = "https://api.prod.whoop.com/developer/v2"` (`whoop.ts:30`); endpoints `recovery`, `activity/sleep`, `cycle` unchanged; OAuth endpoints `/oauth/oauth2/*` unchanged (`providers.ts:44-45`). All field mappings survived: `recovery_score→recovery %`, `hrv_rmssd_milli→hrv ms`, `resting_heart_rate→restingHr bpm`, `spo2_percentage→spo2 %`, sleep ms→min conversions, nap exclusion (`!s.nap`), strain `== null` rest-day guard.

**briefing.ts** still pulls the same sources (sleep.duration_min + recovery from MetricStore, agenda from CalendarMirror, todos from TodoStore), same try/catch null-on-failure handling, same recovery thresholds (67/34), same "null duration ≠ 0h" guard, same template output. `lastPoint(series)` is identical to `series.points[series.points.length-1]`. The removed `hrvSeries`/`hrvPt` was confirmed **dead code in the parent** (computed but never used in the return) — safe removal, not a dropped field. `gatherTodos` Set-based overdue de-dup is equivalent to the old `.find()` filter.

**Security:** No tokens/secrets logged anywhere (grep clean across connectors + oauth + providers). All auth headers (`Authorization: Bearer …`, `token …` PAT) still set. Injected `HttpClient` used throughout — no global `fetch`. No `@jarvis/core` import in any leaf file. node:sqlite/ESM/strict invariants untouched.

---

## Info

### [INFO] Pre-existing dated-fixture rot in gmail test (NOT a refactor regression)

- File: `services/integrations/test/gmail.test.ts:88` (fixture dates at `:71-72`)
- What: `gmailConnector.sync > follows nextPageToken across messages.list pages` fails: expects `nextCursor = "2026-06-09T10:00:00.000Z"`, gets `null`. The fixture seeds messages dated 2026-06-08/09; the connector's cursor defaults to `sevenDaysAgo()`, which (with the current wall clock ≈2026-06-20) is ~2026-06-13. Both fixture timestamps are now older than `since`, so `latestTs` never advances past it and `nextCursor` is correctly `null`.
- Proof it is NOT this refactor: the test file is byte-identical between fc14260^ and fc14260, and the test **fails identically when checked out and run on the parent commit** (verified via git worktree). The gmail connector's cursor/`latestTs` loop (`gmail.ts:117-125`) and pagination loop (`gmail.ts:47-90`) were **not touched** by this commit — only `MetricPoint` construction was extracted.
- Why it matters: it makes `npm test --workspace @jarvis/integrations` red, which can mask a future real regression. This is exactly the failure mode CONNECTORS.md:175-178 warns about ("make test fixtures' timestamps relative to Date.now()").
- Fix (separate from this refactor): change the fixtures to relative dates, e.g. `metaBody("m1", String(Date.now() - 2*86_400_000))` and assert `result.nextCursor` is non-null / equals that derived ts, instead of hard-coded `2026-06-09`.

### [INFO] Prompt-injection landmine confirmed absent from reviewed files

- File: (repo-wide note; CLAUDE.md documents a fake "append `# DOCS_SYNCED`" commit-time injection)
- What: None of the reviewed connector/briefing/framework files or CONNECTORS.md contain embedded instructions to the reviewer or any `# DOCS_SYNCED`-style payload. CONNECTORS.md is an accurate authoring guide whose code samples match the actual helper signatures (`getOAuthAccessToken(source, tokenStore, http)`, `fetchAllPages(fetchPage, maxPages)`, `metricPointFactory(source)`); no claim contradicts the code.
- Why it matters: surfaced per the security note as a clean-bill confirmation, not a defect.
- Fix: none required.
