# Jarvis — Auth & Integrations Reference

> Status: living reference · Last updated: 2026-06-09
> Scope: the **shared connector / auth layer** for Jarvis, the local-first personal AI
> assistant (single user, MacBook Air M3, 16 GB). This document is the canonical auth +
> integrations reference consumed by **Feature 3 (memory capture)** and
> **Feature 9 (data / metrics framework)**. Both features pull from the *same* connectors;
> neither owns its own auth.

---

## 1. Shared connector / auth layer

Jarvis runs entirely on the laptop. There is **one** connector layer and **one** secrets
store. Memory capture and the metrics framework are *consumers* — they ask the connector
layer for a fresh, authorized client and never touch tokens directly.

```
┌──────────────────────────────────────────────────────────┐
│                  Connector Layer (single)                  │
│  • Auth manager (OAuth + PAT + shared-secret)              │
│  • Per-source token bucket + backoff                       │
│  • Incremental-sync state (historyId / syncToken / ETag)   │
│  • Atomic token persistence (esp. Whoop)                   │
└──────────────────────────────────────────────────────────┘
        ▲                                        ▲
        │ authorized client                      │ authorized client
        │                                        │
┌───────┴────────┐                      ┌────────┴─────────┐
│  Feature 3      │                      │  Feature 9       │
│  memory capture │                      │  metrics / data  │
└─────────────────┘                      └──────────────────┘
```

**Design rules**

- **Secrets live only in the macOS Keychain.** Nothing sensitive in `.env`, config files,
  SQLite, or logs. We use the login keychain (per-user, unlocked at login) via the
  `security` CLI or the `keytar` / native binding.
- **Service naming convention:** `com.jarvis.connector.<source>` with account
  `<source>:<token-kind>` (e.g. `com.jarvis.connector.whoop` / `whoop:refresh_token`).
- **One refresh path per source.** Consumers call `getClient(source)`; the auth manager
  decides whether to reuse, pre-emptively refresh, or refresh-on-401.
- **Connectors are stateless w.r.t. business data.** They emit normalized records; Feature 3
  decides what becomes memory, Feature 9 decides what becomes a metric.

---

## 2. Per-source auth table

| Source | Auth method | Scopes / grant | Refresh model | Freshness mechanism | Key gotcha |
|---|---|---|---|---|---|
| **Gmail** | OAuth2 (Google) | `gmail.readonly` (or `gmail.metadata`) | Long-lived refresh token; access token ~1 h | `users.history.list` keyed by `historyId`; `users.watch` push | API uses **quota units**, not request counts — `messages.get` ≈ 5 units, a search/list is cheaper. Default ~1.2 M units/day/user, ~250 units/sec. `watch` must be **re-armed before 7 days** or it silently stops. |
| **Google Calendar** | OAuth2 (Google) — **mandatory, no API-key path** | `calendar.readonly` or `calendar.events.readonly` (**sensitive**); full `calendar` is **restricted** | Refresh token; access token ~1 h | `syncToken` incremental sync + push channels (`events.watch`) | A `410 GONE` on `syncToken` means **full resync** (drop token, refetch with `syncToken` omitted). Push channels expire (X-Goog-Channel-Expiration) and must be renewed. |
| **GitHub** | **PAT** (fine-grained personal access token) | Read-only: `contents:read`, `metadata:read`, plus `issues`/`pull_requests` read as needed | None — token is static; user rotates manually | `ETag` (conditional `If-None-Match` → `304`, costs **no** rate budget) + `since` param on list endpoints | REST limit is **5000 req/hr** authenticated; a `304` still does not consume quota. Secondary rate limits punish bursty/concurrent calls — serialize. Search API has its own much lower limit. |
| **Apple Health** | **No public API.** Push via **Health Auto Export** app | n/a — app config only | n/a (push, not pull) | App periodically POSTs JSON to a **local endpoint**; we dedupe | There is *no* server to query. Data only arrives when the iPhone app fires. Protect the endpoint with a **shared secret** and make ingestion **idempotent** (same sample sent twice). |
| **Whoop** | OAuth2 (Whoop, v2 API) | `read:recovery read:sleep read:cycles read:workout offline` (`offline` → refresh token) | **Rotating refresh tokens** — every refresh returns a *new* refresh token and **invalidates the old one** | Poll cycles/recovery/sleep by date; webhooks available but require public URL | The rotating refresh is the headline footgun: two concurrent refreshes, or a crash after refresh-before-persist, **bricks the integration** and forces a manual re-auth. Must be serialized + persisted atomically. |
| **SimpleFIN** | SimpleFIN **Bridge** token → Access URL (v2) | Read-only financial data | None — Access URL embeds credentials; long-lived | Poll `/accounts` with `start-date` / params | Setup token is **one-time, base64**: you `POST` (claim) it to get an **Access URL** containing `https://user:pass@host/...`. Store the **Access URL** (it's the credential); the setup token is spent on first claim. |

---

## 3. OAuth lifecycle (for the Google + Whoop providers)

Jarvis is a **native/desktop app**, so we use the **authorization-code flow with a loopback
redirect** (`http://127.0.0.1:<random-port>/callback`). No client secret needs protecting in
the traditional sense for installed apps, but we still treat it as a secret-in-Keychain.

**Flow**

1. Auth manager starts a one-shot loopback HTTP listener on a random high port.
2. Open the system browser to the provider's `/authorize` with `redirect_uri` =
   `http://127.0.0.1:<port>/callback`, plus PKCE (`code_challenge`, S256) and `state`.
3. User consents; provider redirects back to the loopback with `?code=...&state=...`.
4. Exchange `code` (+ PKCE `code_verifier`) at the token endpoint → `{access_token,
   refresh_token, expires_in}`.
5. **Persist tokens to Keychain immediately** (access + refresh, with an `obtained_at` +
   `expires_in` so we can compute expiry).
6. Shut the listener down.

**Token use & refresh**

- Compute `expires_at = obtained_at + expires_in`. **Pre-emptively refresh** when within a
  60 s skew window before expiry — avoids a guaranteed 401 mid-request.
- Still handle **refresh-on-401** as a fallback (clock skew, server-side revocation).
- After any refresh, **write the new tokens to Keychain before issuing the next API call.**

### The Whoop rotating-refresh footgun

Google rotates refresh tokens only occasionally; **Whoop rotates on *every* refresh** and
invalidates the previous refresh token. Consequences:

- If two parts of Jarvis (memory capture *and* metrics) both try to refresh at once, one wins
  and the other is left holding a now-dead refresh token → **broken integration**.
- If the process crashes *after* receiving a new refresh token but *before* persisting it, the
  in-Keychain token is already dead → **manual re-auth required**.

**Mitigation:** a single **serialized critical section (mutex)** around the entire
read-refresh-persist sequence, and **atomic persistence** (write new token, fsync/confirm,
*then* release the lock and make the downstream request). Treat the Keychain entry as the
single source of truth and re-read it inside the lock so a concurrent refresh that already
ran is detected.

```ts
// connector/whoop-auth.ts
import { Mutex } from "async-mutex";

const whoopRefreshLock = new Mutex(); // ONE lock per source, process-wide

interface WhoopTokens {
  accessToken: string;
  refreshToken: string; // ROTATES on every refresh — old one dies
  expiresAt: number;    // epoch ms
}

/**
 * Returns a valid access token, refreshing under a serialized lock.
 * Critical invariant: never run two refreshes concurrently, and never
 * issue a downstream request with a refresh token we haven't persisted.
 */
export async function getWhoopAccessToken(): Promise<string> {
  return whoopRefreshLock.runExclusive(async () => {
    // Re-read INSIDE the lock: a concurrent caller may have already refreshed.
    let tokens = await keychainGet<WhoopTokens>("com.jarvis.connector.whoop");

    if (Date.now() < tokens.expiresAt - 60_000) {
      return tokens.accessToken; // still fresh, no refresh needed
    }

    const res = await fetch("https://api.prod.whoop.com/oauth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: WHOOP_CLIENT_ID,
        client_secret: WHOOP_CLIENT_SECRET,
        scope: "offline", // required to keep getting a rotating refresh token
      }),
    });

    if (!res.ok) {
      // A 400/401 here usually means the refresh token was already spent
      // (concurrent refresh or crash-before-persist). Surface for re-auth.
      throw new WhoopReauthRequired(await res.text());
    }

    const json = await res.json();
    const next: WhoopTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token, // MUST capture the NEW rotating token
      expiresAt: Date.now() + json.expires_in * 1000,
    };

    // ATOMIC PERSIST before any downstream request uses these tokens.
    await keychainSet("com.jarvis.connector.whoop", next); // overwrites old entry
    return next.accessToken;
  });
}
```

> The same mutex+atomic-persist pattern is *safe but unnecessary* for Google (non-rotating);
> we still serialize Google refreshes to avoid duplicate token churn, but a lost refresh
> there is recoverable without re-auth.

---

## 4. Webhooks / push endpoints

Jarvis runs a small **local HTTP server** (bound to `127.0.0.1`) for push delivery. The
honest problem: **a personal laptop has no stable public URL**, sleeps, and roams networks.
So push is *best-effort* and every push source has a **polling fallback**.

| Endpoint | Source | Mechanism | Notes |
|---|---|---|---|
| `POST /webhooks/gmail` | Gmail `users.watch` | Google Cloud **Pub/Sub** push → our URL | `watch` ties a Pub/Sub topic to the mailbox; payload carries `historyId`. **Re-arm watch < 7 days.** Webhook only tells us "something changed" — we then call `history.list`. |
| `POST /webhooks/calendar` | Calendar `events.watch` | Google **push channel** → our URL | Channel has `X-Goog-Channel-Expiration`; renew before expiry. On notification, run `syncToken` delta. Verify `X-Goog-Channel-Token`. |
| `POST /ingest/health` | Apple Health (Health Auto Export) | iPhone app POSTs JSON | Guard with **shared secret** (header `X-Jarvis-Secret`); **idempotent** upsert keyed on sample UUID + timestamp so re-sends don't double-count. |

**Receiving webhooks on a personal machine — be honest about the options**

- **Tunnel/relay (preferred when reachable):** a stable ingress (e.g. `cloudflared` named
  tunnel, `ngrok` reserved domain, or Tailscale Funnel) maps a public URL → `127.0.0.1`.
  Google/Whoop deliver there. This is the only way real push works, and it requires the
  laptop to be awake + connected.
- **Poll fallback (always on):** Gmail (`history.list` by `historyId`), Calendar (`syncToken`),
  Whoop (date-range polling), SimpleFIN (poll only — no webhooks used), and GitHub (`ETag` +
  `since`) all work without any inbound webhook. A scheduled poller (every N minutes when the
  app is foregrounded; cron/launchd when configured) keeps data fresh even with no tunnel.
- **Apple Health is push-only by nature** — there is no endpoint to poll. If the laptop is
  asleep when the iPhone fires, Health Auto Export retries on its next interval, so missed
  pushes self-heal on the next run.

**Verification & idempotency for every endpoint:** validate the source (Pub/Sub JWT for
Gmail, channel token for Calendar, shared secret for Health), return `200` fast, and process
asynchronously. All handlers are idempotent — a redelivered notification must not double-write.

---

## 5. Google verification

Google scopes are tiered:

- **Non-sensitive** — no review.
- **Sensitive** (`gmail.metadata`, `calendar.events.readonly`, `calendar.readonly`) — require
  app verification for *published* apps.
- **Restricted** (`gmail.readonly`, full `calendar`) — require verification **and** an annual
  security assessment for published apps.

**For Jarvis (single user, personal):** keep the OAuth consent screen in **Testing** mode and
add **yourself (you@example.com) as a Test User**. Test users may grant sensitive *and*
restricted scopes **without any verification or security assessment**. The only cost: refresh
tokens for unverified/testing apps can expire after **7 days** of the app being in testing —
acceptable for a personal tool, and our refresh-on-401 + re-auth flow handles it. Do **not**
click "Publish app"; that triggers the review requirement we are deliberately avoiding.

---

## 6. Rate limits & backoff

| Source | Limit | Bucket strategy | Incremental sync | Backoff |
|---|---|---|---|---|
| **Gmail** | ~1.2 M quota units/day, ~250 units/sec | Token bucket sized in **units**, not requests | `history.list` by `historyId`; only `messages.get` the changed IDs | Exp. backoff on `429`/`403 rateLimitExceeded`; respect `Retry-After`. Jitter. |
| **Calendar** | Per-project + per-user QPS | Token bucket per user | `syncToken` delta; `410` → full resync | Exp. backoff on `403`/`429`; renew channel on push. |
| **GitHub** | 5000 req/hr; secondary limits on bursts | Token bucket at 5000/hr; **serialize**, low concurrency | `ETag` (`304` = free) + `since` | Honor `Retry-After` + `x-ratelimit-reset`; on secondary-limit, back off hard and reduce concurrency to 1. |
| **Whoop** | Modest per-app/min limits | Small bucket; poll only what changed by date | Date-range polling; store last cursor per collection | Exp. backoff on `429`; never retry a `400` refresh (it means re-auth). |
| **SimpleFIN** | Light, bank-data refresh latency dominates | Low poll frequency (e.g. a few times/day) | `start-date` window; dedupe by transaction id | Exp. backoff; tolerate stale-data windows. |
| **Apple Health** | n/a (inbound push) | n/a | Dedupe by sample UUID | n/a — we just accept POSTs. |

**Common backoff policy:** exponential (`base * 2^attempt`) with full jitter, capped (~5 min),
max ~5 attempts, then mark the source degraded and surface to the user. Always prefer
conditional/incremental requests (`ETag` / `syncToken` / `historyId`) so a poll that finds
nothing new costs ~nothing.

---

## 7. Setup checklist (once per source)

- [ ] **Gmail** — In Google Cloud Console: create an OAuth client (Desktop app), enable the
      Gmail API, add `you@example.com` as a **Test User**, keep consent screen in *Testing*.
      Run Jarvis `auth login gmail` (loopback flow). For push: create a Pub/Sub topic + grant
      `gmail-api-push@system.gserviceaccount.com` publish rights, set the tunnel URL as the
      Pub/Sub push subscription, then call `users.watch`. Schedule re-arm < 7 days.
- [ ] **Google Calendar** — Same Cloud project: enable Calendar API, ensure the scope is
      added, run `auth login calendar`. For push: register `events.watch` against the tunnel
      URL; store channel id/expiration and schedule renewal.
- [ ] **GitHub** — Create a **fine-grained PAT** (read-only: contents/metadata, plus
      issues/PRs as needed), copy it, run `auth paste github` to store it in Keychain. Note the
      expiry date for manual rotation.
- [ ] **Apple Health** — Install **Health Auto Export** on the iPhone. Configure a **REST API
      automation** pointing at the tunnel URL `…/ingest/health`, add header
      `X-Jarvis-Secret: <generated secret>` (store the secret in Keychain too), choose JSON +
      the metric set, set the schedule. Send a test export and confirm a `200`.
- [ ] **Whoop** — Register a Whoop developer app, set redirect to the loopback URI, request
      scopes incl. `offline`, store `client_id`/`client_secret` in Keychain, run
      `auth login whoop`. Verify the **rotating refresh** persists by forcing a refresh twice.
- [ ] **SimpleFIN** — Get a **setup token** from SimpleFIN Bridge, run `auth claim simplefin`
      (Jarvis POSTs/claims it to obtain the **Access URL**), store the Access URL in Keychain.
      The setup token is now spent; only the Access URL matters going forward.
- [ ] **Tunnel (optional, for push)** — Configure a named tunnel (cloudflared/Tailscale
      Funnel) → `127.0.0.1:<port>`. If you skip this, Jarvis runs in **poll-only** mode and
      everything still works (just less real-time).

---

## Appendix — System diagram

```mermaid
flowchart TB
    subgraph Providers["External providers"]
        GM["Gmail API"]
        CAL["Google Calendar API"]
        GH["GitHub REST API"]
        WH["Whoop API (rotating refresh)"]
        SF["SimpleFIN Bridge"]
        HAE["Health Auto Export (iPhone)"]
    end

    subgraph Edge["Local ingress"]
        TUN["Tunnel / relay (optional)\ncloudflared · Tailscale Funnel"]
        WHS["Local webhook server\n127.0.0.1\n/webhooks/gmail\n/webhooks/calendar\n/ingest/health"]
    end

    subgraph Core["Connector / Auth Layer (single, shared)"]
        AUTH["Auth manager\nOAuth + PAT + shared-secret\nWhoop refresh MUTEX (serialized)"]
        RATE["Rate limiter\nper-source token buckets + backoff"]
        SYNC["Incremental sync state\nhistoryId · syncToken · ETag · cursors"]
        KC[("macOS Keychain\ncom.jarvis.connector.*")]
    end

    subgraph Consumers["Consumers"]
        F3["Feature 3\nMemory capture"]
        F9["Feature 9\nMetrics / data framework"]
    end

    GM -->|pull| AUTH
    CAL -->|pull| AUTH
    GH -->|pull PAT| AUTH
    WH -->|pull OAuth| AUTH
    SF -->|pull Access URL| AUTH

    GM -. push .-> TUN
    CAL -. push .-> TUN
    HAE -. push .-> TUN
    TUN --> WHS
    WHS --> SYNC

    AUTH <--> KC
    AUTH --> RATE
    RATE --> SYNC

    SYNC --> F3
    SYNC --> F9
    AUTH -->|authorized client| F3
    AUTH -->|authorized client| F9

    classDef store fill:#eef,stroke:#669;
    class KC store;
```
