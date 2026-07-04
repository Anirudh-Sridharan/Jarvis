# Deep Code Review — apps/dashboard (commit fc14260, parent 20c709d)

**Scope:** 13 dashboard files in the "readability pass + connector onboarding abstraction" refactor.
**Focus:** behavior preservation of the new `fetchEnvelope.ts` helper across all adopters; React correctness; BFF write-boundary integrity (`api/profile/route.ts`).

**STATUS: PASS (no behavior changes found).** The refactor is faithful: the extracted fetch helper, the `ProfileView.mutateProfile` consolidation, the `ConnectorPanel.setMsg` extraction, and the `api/profile` `toFactContract` extraction are all behavior-preserving. Dashboard `tsc --noEmit -p tsconfig.json` is clean (exit 0, zero diagnostics).

**COUNTS: critical=0  warning=0  info=2**

---

## Verification performed (why this is PASS, not just "looks fine")

- **`fetchEnvelope.ts` is byte-equivalent to every inline helper it replaced.** The old per-page `fetchJson`/`fetchSeries`/`fetchProfile`/`fetchConnectors`/`fetchMemories` all did exactly `fetch(\`${BASE}${path}\`, { cache: "no-store" })` then `(await res.json()) as WidgetEnvelope<T>`, wrapped in a `try/catch` that synthesized an identical `{ data:null, state:"error", error:{ code:"FETCH_ERROR", message }, meta:{ source:"none", ... latencyMs:0 } }` envelope. `fetchEnvelope` reproduces this verbatim. **Important: the old helpers never checked `res.ok` / HTTP status** — they parsed the body regardless — and the new helper preserves that exactly. So no HTTP-status check was *lost* (there was none to lose; non-2xx still flows through as whatever the route's JSON body says, which for these BFF routes is always a valid envelope).
- **Per-page messages preserved.** Only `profile/page.tsx` used a custom unreachable message ("Profile service unreachable"); it now passes `fetchEnvelope(..., "Profile service unreachable")`. All others used the default "Service unreachable", which is the helper's default. No message regressed.
- **No dropped `await` / changed async semantics.** The migrated wrappers (`health`, `work`, `memory`, `profile`, `integrations`) changed from `async function` to plain functions that `return fetchEnvelope(...)` — this returns the same `Promise<WidgetEnvelope<T>>` and every call site already `await`s it. Semantically identical.
- **Loading/empty/error rendering unchanged.** No page's `state === "error"` / `state === "empty"` / `!data` branches were touched; only the import line + helper body changed.
- **`ProfileView.mutateProfile`** preserves the old per-handler logic exactly: `setError(null)` → `startTransition` → POST → `if (env.data) setProfile(env.data); else if (env.error) setError(env.error.message)` → catch `setError(e instanceof Error ? e.message : failureLabel)`. The four old handlers' failure labels map 1:1 ("Correction failed" / "Pin update failed" / "Forget failed" / "Forget failed"). Method + body per handler unchanged.
- **`ConnectorPanel.setMsg`** is a pure extraction of `setSyncMsg((m) => ({ ...m, [source]: { ok, text } }))`. Functional-update form preserved (no stale-closure regression). `setMsg` is `useCallback(…, [])` (stable), so adding it to `connect` deps (`[connecting, setMsg]`) and `syncNow` deps (`[syncing, refresh, setMsg]`) does not change either callback's identity churn vs. before — exhaustive-deps correct, no extra re-subscription. The 5-min poll (100 × 3 000 ms) and all branch transitions are unchanged.
- **`TodoList` snooze** swapped a hand-rolled local `YYYY-MM-DD` formatter for `localDateStr(new Date(Date.now() + 86_400_000))`. `localDateStr` (dates.ts:11) builds the string from `getFullYear/getMonth/getDate` with the same zero-padding — identical output, still local-time. No off-by-one.
- **BFF write boundary intact (`api/profile/route.ts`).** GET/PATCH/DELETE handler bodies are unchanged by this commit (diff only touches the `toContract`/`toFactContract` mapper, lines ~9–66). Bi-temporal correction semantics (`correctFact`, `setPinned`, `forgetFact`, `forgetEntity`) are still delegated to `@jarvis/memory` unchanged; the XOR request guards (PATCH: correction-xor-pinned; DELETE: entityName-xor-factId) are intact; no new write path was introduced. `toFactContract` reproduces the old inline field mapping exactly for all five facets (preferences/communicationStyle pass `f.value`; people `{name,relationship,notes}`; projects `{name,status,description}`; routines `{description,cadence}`), with identical metadata (id/confidence/pinned/source/provenance/updatedAt/conflictsWith).
- **`server-only` import is safe here.** All 8 `fetchEnvelope` consumers are async Server Components (no `"use client"`); the helper is never pulled into a client bundle. `tsc` passes; Next resolves the bare `server-only` specifier via its bundled `next/dist/compiled/server-only` (it's a declared dependency of `next`). See IN-01.
- **No design-system landmines reintroduced** (no setState-driven clocks, no `backdrop-filter`) and **no `JARVIS_DATA_DIR`/relative-path data access** in these files (data access stays behind the BFF routes, unchanged).
- **Prompt-injection check:** no embedded instructions to the reviewer (no "DOCS_SYNCED" marker or similar) found in any reviewed file.

---

## Info

### [INFO] `server-only` is not a declared dashboard dependency (resolves only via Next's bundled copy)
- File: `apps/dashboard/app/lib/fetchEnvelope.ts:14`
- What: The new helper adds `import "server-only";`. `server-only` is **not** in `apps/dashboard/package.json` and is **not** resolvable by Node (`require.resolve('server-only')` → MODULE_NOT_FOUND; absent from `node_modules`). It works today only because `next@^15` declares `server-only@0.0.1` as its own dependency and ships `next/dist/compiled/server-only`, which the Next webpack/turbopack config aliases. `tsc --noEmit` is clean and `next build` will resolve it.
- Why it matters: This is a guard rail (it would throw a useful build error if the helper were ever imported into a client component), so keeping it is good. The risk is purely fragility: relying on a transitive Next internal means a future Next major that stops bundling/aliasing `server-only` would break the build of a file that doesn't declare the dep. Not a current defect.
- Fix: Add `"server-only": "^0.0.1"` to `apps/dashboard/package.json` dependencies so the import is satisfied by a directly-declared package rather than a Next internal.

### [INFO] `toFactContract<TOut>(fact: ProfileFact<unknown>, value: TOut)` drops the value↔fact type link
- File: `apps/dashboard/app/api/profile/route.ts:23-26`
- What: Typing the fact param as `ProfileFact<unknown>` decouples `value`'s type from the fact's own value type. A caller could pass a `value` derived from a different/mismatched fact and the compiler would not object. All five live call sites (lines 41–62) pass the matching `f`, so the emitted contract is correct — no runtime bug. This is a minor type-safety regression relative to the previous fully-inlined, fully-typed mapping.
- Why it matters: Loses one layer of compile-time protection on the BFF's profile-shaping path; a future edit to one facet's mapper could silently emit a wrong-shaped `value`.
- Fix: Constrain the generic, e.g. `function toFactContract<TIn, TOut>(fact: ProfileFact<TIn>, value: TOut): ProfileFactContract<TOut>` (keeps the same call sites, restores an explicit `TIn` so the source fact is typed), or pass the value-mapper as a callback `(f) => toFactContract(f, map(f.value))` typed against `ProfileFact<TIn>`.

---

_Reviewer: Claude (deep review). Behavior-preservation verified hunk-by-hunk against `git show fc14260^:<file>`; dashboard typecheck run clean._
