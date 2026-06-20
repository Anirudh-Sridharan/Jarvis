# Adding a connector

A **connector** pulls data from one external source (Whoop, GitHub, …) and
normalizes it into `MetricPoint`s (and, for calendars, `CalendarEvent`s) that the
rest of Jarvis stores and queries. The framework handles the repetitive parts —
OAuth refresh, pagination, idempotent point construction, scheduling, cursor
persistence — so a new connector is mostly *"fetch this, map it to that."*

This guide adds an OAuth connector called `acme`. Adjust the auth step for
PAT/push sources (see [Auth kinds](#auth-kinds)).

## The contract

A connector is a plain object implementing [`Connector`](src/types.ts):

```ts
interface Connector {
  id: SourceId;        // stable id; also the TokenStore + cursor key
  auth: AuthKind;      // "oauth" | "pat" | "push"
  schedule: string;    // cron, e.g. "0 7 * * *"
  concurrency: number; // 1 if the source uses rotating refresh tokens (else 2)
  sync(cursor, http, tokenStore): Promise<ConnectorSyncResult>;
}
```

`sync()` fetches everything newer than `cursor`, normalizes it, and returns
`{ points, nextCursor }`. **Throw to fail a run** — the Scheduler records the
error and leaves the cursor where it was, so the same window is retried (never
advance the cursor past data you didn't actually persist).

## The three helpers you'll use

| Helper | Module | What it removes |
| --- | --- | --- |
| `getOAuthAccessToken(source, tokenStore, http)` | `framework/providers.ts` | Manual `getAccessToken(... , getRefreshConfig(...), isRotating)` wiring. Pulls the token URL, credentials, refresh params **and the rotating-refresh flag** from the provider catalog — so you can't forget `isRotating` on a rotating source. |
| `fetchAllPages(fetchPage, maxPages)` | `framework/pagination.ts` | The copy-pasted "loop until there's no next page token" boilerplate. You describe one page; it flattens them all (with a safety cap). |
| `metricPointFactory(source)` | `framework/normalize.ts` | The 9-field `MetricPoint` literal. The returned `point({...})` fills in the deterministic `id`, the batch `ingestedAt`, and `adapterVersion`. |

## Steps

### 1. Declare the source id

In [`src/types.ts`](src/types.ts), add to the `SourceId` union:

```ts
export type SourceId = "apple_health" | "whoop" | … | "acme";
```

### 2. (OAuth only) Register the provider

In [`src/framework/providers.ts`](src/framework/providers.ts), add an entry to
`PROVIDERS` and to the `OAuthSourceId` union. Set `rotatingRefresh: true` if each
refresh invalidates the previous refresh token (then also use `concurrency: 1` in
the connector). Credentials are read from the named env vars at call time.

```ts
acme: {
  source: "acme",
  displayName: "Acme",
  authorizeUrl: "https://acme.com/oauth/authorize",
  tokenUrl: "https://acme.com/oauth/token",
  scopes: ["read:data", "offline"],
  clientIdEnv: "ACME_CLIENT_ID",
  clientSecretEnv: "ACME_CLIENT_SECRET",
  pkce: true,
  rotatingRefresh: false,
},
```

### 3. Write the connector

Create `src/connectors/acme.ts`:

```ts
import type { Connector, ConnectorSyncResult, Cursor, HttpClient, MetricPoint, TokenStore } from "../types.js";
import { getOAuthAccessToken } from "../framework/providers.js";
import { fetchAllPages } from "../framework/pagination.js";
import { metricPointFactory } from "../framework/normalize.js";
import { httpError } from "../framework/httpError.js";

const API = "https://api.acme.com/v1";
const MAX_PAGES = 10;

export const acmeConnector: Connector = {
  id: "acme",
  auth: "oauth",
  schedule: "0 6 * * *",
  concurrency: 2, // 1 if the provider has rotatingRefresh

  async sync(cursor: Cursor | null, http: HttpClient, tokenStore: TokenStore): Promise<ConnectorSyncResult> {
    const token = await getOAuthAccessToken("acme", tokenStore, http);
    const since = cursor?.highWater ?? thirtyDaysAgo();

    const records = await fetchAllPages<AcmeRecord>(async (pageToken) => {
      const params = new URLSearchParams({ since, limit: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await http.request({
        method: "GET",
        url: `${API}/metrics?${params}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) throw httpError("Acme sync failed", res);
      const body = res.body as { records?: AcmeRecord[]; nextPageToken?: string | null };
      return { items: body.records ?? [], nextPageToken: body.nextPageToken };
    }, MAX_PAGES);

    const points = records.flatMap(normalizeAcme);
    const latestTs = points.reduce((max, p) => (p.ts > max ? p.ts : max), since);
    return { points, nextCursor: latestTs !== since ? latestTs : null };
  },
};

interface AcmeRecord { ts?: string; steps?: number }

// Exported so it can be unit-tested directly (see existing connector tests).
export function normalizeAcme(r: AcmeRecord): MetricPoint[] {
  if (r.steps == null || !r.ts) return [];
  const point = metricPointFactory("acme");
  return [point({ metric: "steps", value: r.steps, unit: "count", ts: r.ts })];
}

function thirtyDaysAgo(): string {
  return new Date(Date.now() - 30 * 86_400_000).toISOString();
}
```

Notes:
- **Idempotency is free.** `metricPointFactory` derives the point `id` from
  `(source, metric, ts, dims)`. Re-syncing an overlapping window upserts instead
  of duplicating — as long as your `dims` are deterministic (no random values).
- **Cursor discipline.** Advance `nextCursor` only to a timestamp you actually
  fetched. Returning `null` when nothing is new keeps the cursor put.

### 4. Register it

In [`src/index.ts`](src/index.ts) `createIntegrations()`:

```ts
import { acmeConnector } from "./connectors/acme.js";
// …
connectors.register(acmeConnector);
```

Export the normalizer too if you want it unit-tested (`export { normalizeAcme } …`).

### 5. Test it

Add `test/acme.test.ts` using the in-memory fakes — no network, no credentials:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { acmeConnector, normalizeAcme } from "../src/connectors/acme.js";
import { clearOAuthState } from "../src/framework/oauth.js";
import { FakeHttp, MemoryTokenStore, makeTokens } from "../src/testing/fakes.js";

describe("acmeConnector", () => {
  beforeEach(() => clearOAuthState());

  it("normalizes and advances the cursor", async () => {
    const http = new FakeHttp();
    const tokenStore = new MemoryTokenStore();
    tokenStore.seed("acme", makeTokens({ expiresAt: Date.now() + 3_600_000 }));
    http.add("/v1/metrics", {
      status: 200, headers: {},
      body: { records: [{ ts: "2026-06-09T00:00:00Z", steps: 8000 }] },
    });

    const result = await acmeConnector.sync(null, http, tokenStore);
    expect(result.points).toHaveLength(1);
    expect(result.nextCursor).toBe("2026-06-09T00:00:00Z");
  });
});
```

> **Tip:** make test fixtures' timestamps relative to `Date.now()` (e.g.
> `new Date(Date.now() - 86_400_000)`), not hard-coded calendar dates. A cursor
> defaulting to "N days ago" is compared against the wall clock, so fixed dates
> make a passing test rot once enough real time goes by.

## Auth kinds

- **`oauth`** — use `getOAuthAccessToken`. Provider must be in the catalog (step 2).
- **`pat`** — read the token from `tokenStore.get(source)` and send it directly;
  no catalog entry needed (see [`github.ts`](src/connectors/github.ts)).
- **`push`** — `sync()` is a no-op; data arrives via an HTTP handler. See
  [`appleHealth.ts`](src/connectors/appleHealth.ts) and its
  `createPushEndpointHandler`.

## Reference

- Connector interface & result type — [`src/types.ts`](src/types.ts)
- Provider catalog & OAuth helper — [`src/framework/providers.ts`](src/framework/providers.ts)
- Pagination — [`src/framework/pagination.ts`](src/framework/pagination.ts)
- Point construction — [`src/framework/normalize.ts`](src/framework/normalize.ts)
- Scheduler (cron, cursors, sync runs) — [`src/framework/scheduler.ts`](src/framework/scheduler.ts)
- Test fakes — [`src/testing/fakes.ts`](src/testing/fakes.ts)
