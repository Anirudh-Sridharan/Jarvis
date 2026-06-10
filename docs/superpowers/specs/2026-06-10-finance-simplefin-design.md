# Finance Metrics v1 slice (SimpleFIN) — Design + Plan

**Date:** 2026-06-10
**Status:** Approved (user chose SimpleFIN-first; un-defers feature 11's first slice)
**Spec contract:** `features/11-finance-metrics.md` (deep spec — schemas/rules followed verbatim)

## Scope of this slice

In (all deterministic, tests on FakeHttp — no credential needed until live):
- `services/integrations/src/finance/types.ts` — `Account`, `AccountBalance`,
  `Transaction`, `Category`, `CategoryRule` exactly per the spec (integer
  minor units, ISO dates).
- `finance/simplefin.ts` — `SimpleFinClient` (injected HttpClient + access
  URL), `syncSimpleFin` normalize per the spec's reference implementation
  (`toMinor` explicit rounding, epoch→ISO, account-type inference,
  institution masking, dedupe hash fallback).
- `finance/financeStore.ts` — SQLite tables (accounts / account_balances /
  transactions / categories), built-in category seed, upsert with the spec's
  dedupe rules (`(accountId, sourceTxnId)` primary, hash fallback,
  pending→posted updates in place — never double-insert), aggregates:
  per-currency net worth (sign-adjusted by `isAsset`, balances authoritative),
  spending-by-category (transfers excluded), income-vs-expenses by month.
- `finance/categorize.ts` — ordered rule engine (user rules before built-ins,
  first match wins, keyword match on normalized description, safe default
  `uncategorized`). AI fallback parameter accepted per spec signature but no
  AI wiring in this slice.
- `IntegrationsSystem.finance = { store, sync({ accessUrl, startDate? }) }` —
  sync fetches, normalizes, categorizes, upserts, then emits `MetricPoint`s
  (`finance.net_worth` per currency-day) into the shared metric store so the
  dashboard/briefing pick finance up like any other metric. `"simplefin"`
  joins the `SourceId` union.

Out (later slices): connect-CLI credential flow (claim a SimpleFIN setup
token → Keychain), daily scheduler registration + rate-limit token bucket,
dashboard finance page wiring beyond its existing needs-connect state, AI
categorization fallback, FX conversion.

## Plan

1. types + simplefin client/normalize + tests (fixture payload, toMinor
   rounding cases, type inference). Commit.
2. financeStore + categorize + tests (dedupe/pending→posted, net-worth signs,
   transfer exclusion, rule order). Commit.
3. index binding + sync orchestration + metric emission + tests; SourceId
   union. Commit.
