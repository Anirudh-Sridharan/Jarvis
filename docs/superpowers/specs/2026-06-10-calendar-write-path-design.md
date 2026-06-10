# Live Google Calendar Write Path — Design

**Date:** 2026-06-10
**Status:** Approved
**Closes:** `TODO(phase5: feature17)` seams in `services/core/src/agent/tools/calendarTools.ts` and `services/integrations/src/connectors/googleCalendar.ts`
**Specs:** `features/12-calendar-integration.md` (write path), `features/17-action-approval-and-safety-gate.md`

## Problem

The agent can propose calendar writes and the approval gate already blocks them
correctly — the ReAct loop (`services/agent/src/core/reactLoop.ts`) gates every
`readOnly:false` tool through `ApprovalService` *before* calling `tool.run()`.
But after approval, nothing real happens:

1. `createEvent` in `googleCalendar.ts` is a stub that returns
   `WriteResult { ok:false, error: 501 }`.
2. The agent tools call it with `null as never` for `http`/`tokenStore` because
   `createIntegrations` never binds the injected transport to the write path.
3. The live server never wires the agent system at all: `server.ts` calls
   `getAgentSystem(gateway, null)` and nothing calls `setAgentSystem()`, so
   `/agent` and `/approvals` return 503 in a live run.

## Design

Per the feature-12 write path: validate → conflict-detect → (approval, already
upstream) → Google-first execute → reconcile mirror → `WriteResult`. Google is
the source of truth; we never invent mirror state (no optimistic write — the
feature-12 overview's "writes go to Google first, then reconcile" wins over the
diagram's optimistic-write variant for simplicity).

### 1. Connector: `executeEventWrite` (@jarvis/integrations)

Replace the `createEvent` stub in `connectors/googleCalendar.ts` with:

```ts
export interface CalendarWriteDeps {
  http: HttpClient;
  tokenStore: TokenStore;
  mirror: CalendarMirror;
}

export async function executeEventWrite(
  req: EventWriteRequest,
  deps: CalendarWriteDeps,
): Promise<WriteResult>
```

Behavior:

- **Validate (deterministic, no network):**
  - `create`: `patch.start`/`patch.end` with `dateTime` required, end > start.
  - `update`: `eventId` required; if both start and end given, end > start.
  - `delete`: `eventId` required.
  - Invalid → `ok:false`, `error: { code: 400, retryable: false }`.
- **Conflict detection:** for `create`/`update` with times, run
  `detectConflicts` against mirror events in the proposed window. Conflicts and
  `!req.allowConflict` → `ok:false`, `error.code: 409`, `conflicts` populated.
  With `allowConflict:true`, proceed but still return the `conflicts` array.
- **Auth:** `getAccessToken("gcal", tokenStore, http, getRefreshConfig("gcal"))`
  — same path the read sync uses (handles refresh).
- **Execute:**
  - `create` → `POST /calendars/{id}/events` with the patch body.
  - `update` → `PATCH /calendars/{id}/events/{eventId}`, `If-Match: <etag>`
    when `req.ifMatchEtag` is set.
  - `delete` → `DELETE /calendars/{id}/events/{eventId}` (treat 204/200/410 as
    success; 410 = already gone).
- **Reconcile:** on success, `normalizeCalendarEvent` the canonical response
  and `mirror.upsertEvent` it (delete → `mirror.tombstoneEvent`). Return
  `ok:true` with the canonical `event`.
- **Errors:** non-2xx → `ok:false`; `retryable:true` for 429/5xx, else false.
  412 (etag mismatch) → `retryable:false` with a clear reason.

Approval is intentionally NOT this function's job — the agent loop gates before
`tool.run()`. The function is pure deterministic transport (no LLM, per spec);
its doc comment states that callers must come through the approval gate.

### 2. Binding in `createIntegrations`

`IntegrationsSystem.calendar` gains a bound method closing over the injected
deps:

```ts
calendar: {
  mirror, findFreeTime, detectConflicts,
  executeWrite: (req: EventWriteRequest) =>
    executeEventWrite(req, { http: config.http, tokenStore: config.tokenStore, mirror: calendarMirror }),
}
```

The old `createEvent` stub and its export are removed (its only callers are the
two agent tools and the type). Tests use the existing fakes
(`FakeHttp`, `MemoryTokenStore`) from `@jarvis/integrations/testing`.

### 3. Agent tools (@jarvis/core)

`calendar_create_event` / `calendar_move_event` call
`integrations.calendar.executeWrite(req)` — no more `null as never`. TODO
markers and "stub" wording removed from descriptions. `calendar_move_event`
stays `op:"update"` with start/end patch. Tool `run()` returns the
`WriteResult` so the agent observes conflicts/errors and can retry with
`allowConflict` or a different slot.

### 4. Live server wiring (@jarvis/core)

New `services/core/src/agent/liveBootstrap.ts`:

```ts
export function bootstrapLiveAgent(gateway: InferenceGateway): AgentSystemBag | null
```

- Calls `createLiveIntegrations()` (real fetch + Keychain) and
  `getAgentSystem(gateway, system)`.
- Returns null (with a logged warning) on failure — server keeps the existing
  graceful-degradation behavior.
- `server.ts` calls it once at startup behind a dynamic import so the module
  graph stays decoupled and tests that inject `setAgentSystem()` are
  unaffected (bootstrap is skipped when a singleton already exists, which
  `getAgentSystem` already guarantees via `initialized`).
- Guarded by `JARVIS_DISABLE_LIVE_AGENT=1` escape hatch for tests/dev.

### 5. Tests

- **Integrations** (`test/googleCalendar.test.ts` or new `calendarWrite.test.ts`):
  create happy path (POST body, auth header, mirror reconciled), update with
  If-Match, delete → tombstone, validation failures (400), conflict block
  (409 + conflicts), allowConflict override, 429/5xx → retryable, 412 → not
  retryable, mirror untouched on failure.
- **Core** (`test/agent-integration.test.ts`): approved `calendar_create_event`
  run drives a FakeHttp POST and returns `ok:true`; rejection never touches
  http (existing approval tests already cover the gate half).
- All tests run with fakes — no network, no credentials, per repo invariant.

## Alternatives considered

- **Pass http/tokenStore into core tool factories:** spreads live transport
  into the core tool layer; breaks the "leaf package owns its I/O behind DI"
  pattern. Rejected.
- **`CalendarWriteService` class:** ceremony with a single consumer. Rejected.
- **Optimistic mirror write + rollback (feature-12 diagram):** more state to
  manage for no user-visible gain in a single-user local app; the spec's own
  overview prescribes Google-first + reconcile. Rejected.

## Out of scope

- Gmail send/draft live path and web research (next tasks).
- Google `watch` push channels (read-path freshness, separate seam).
- Recurrence editing semantics beyond passing `recurrence` through the patch.
