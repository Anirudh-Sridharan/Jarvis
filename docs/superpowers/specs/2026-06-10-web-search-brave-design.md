# Live web_search via Brave Search API — Design + Plan

**Date:** 2026-06-10
**Status:** Approved (Brave Search API chosen over DDG scrape / SearXNG)
**Closes:** `TODO(prod: wire a real search API/MCP)` in `services/core/src/agent/tools/webResearchTools.ts`

## Design

`web_search` becomes a factory `makeWebSearchTool(fetchFn = fetch)` in
`webResearchTools.ts`, mirroring `web_fetch`'s conventions (AbortController
timeout, structured `ok:false` errors, read-only — no approval).

- **Endpoint:** `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…`
  with headers `Accept: application/json`, `X-Subscription-Token: $BRAVE_API_KEY`.
- **Key:** `BRAVE_API_KEY` read from env at call time (`.env` auto-loads in the
  server; tests never set it). Missing key → structured
  `{ ok:false, error: "BRAVE_API_KEY not set …" }` note, NOT a throw — same
  graceful-degradation style as the old stub.
- **Mapping:** `body.web.results[] → { title, url, snippet }`, capped at
  `max_results` (schema default 5, max 20).
- **Errors:** non-200 → `{ ok:false, status, error }`; network/timeout →
  `{ ok:false, error }`. 10s default timeout.
- **Testability:** `fetchFn` parameter injected; `tools/index.ts` calls
  `makeWebSearchTool()` for the real tool. New `services/core/test/webSearch.test.ts`
  with a stubbed fetchFn: happy path mapping + cap, missing key, HTTP error,
  timeout/network error, query URL-encoding.

## Plan

1. Test file + factory rewrite (keep `webSearchTool` export removed; registry
   uses the factory). Build + core suite. Commit.
2. CLAUDE.md: web_search live with `BRAVE_API_KEY`; no remaining stubbed agent
   tools. Commit.

Live-run note: free tier needs a key from https://api-dashboard.search.brave.com
→ `.env` `BRAVE_API_KEY=…`.
