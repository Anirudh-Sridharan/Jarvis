/**
 * OAuth2 refresh machinery with two key properties:
 *
 *  1. Single-flight per source: concurrent calls for the same source share one
 *     in-flight refresh promise. The token is resolved exactly once.
 *
 *  2. Whoop serialization: because Whoop uses ROTATING refresh tokens, the
 *     refresh must be a critical section — concurrent attempts would invalidate
 *     each other. We maintain a per-source mutex so only ONE refresh runs at a
 *     time. All other waiters receive the refreshed token after the lock is
 *     released.
 */

import type { HttpClient, TokenStore, OAuthTokens, SourceId } from "../types.js";

interface RefreshConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

// Per-source in-flight refresh promises (single-flight guard)
const inFlight = new Map<SourceId, Promise<OAuthTokens>>();

// Per-source mutex: a chained promise that serializes critical section
const mutexTail = new Map<SourceId, Promise<void>>();

/**
 * Get a valid access token for the given source.
 * Refreshes if expired or about to expire (within 60s).
 * For Whoop (rotating refresh), the refresh is serialized under a mutex.
 *
 * @param source     Source identifier
 * @param tokenStore Token persistence
 * @param http       HTTP client for token endpoint calls
 * @param config     OAuth2 config (token URL, client credentials)
 * @param isRotating Whether this source uses rotating refresh tokens (Whoop = true)
 */
export async function getAccessToken(
  source: SourceId,
  tokenStore: TokenStore,
  http: HttpClient,
  config: RefreshConfig,
  isRotating = false
): Promise<string> {
  const tokens = await tokenStore.get(source);
  if (!tokens) {
    throw new Error(`No OAuth tokens for source: ${source}. Re-consent required.`);
  }

  const now = Date.now();
  const expiresAt = tokens.expiresAt ?? 0;
  const needsRefresh = expiresAt - now < 60_000; // refresh within 60s of expiry

  if (!needsRefresh) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new Error(`Token expired and no refresh token for source: ${source}`);
  }

  // Single-flight: if there's already an in-flight refresh for this source, wait for it
  const existing = inFlight.get(source);
  if (existing) {
    const refreshed = await existing;
    return refreshed.accessToken;
  }

  if (isRotating) {
    // SERIALIZED rotating-refresh critical section (Whoop):
    // Chain on the existing mutex tail so only one refresh runs at a time.
    // Other waiters will use the token persisted after the first refresh.
    const prev = mutexTail.get(source) ?? Promise.resolve();
    let resolveMutex!: () => void;
    const next = new Promise<void>((r) => {
      resolveMutex = r;
    });
    mutexTail.set(source, next);

    const refreshPromise = prev.then(async () => {
      try {
        // Re-check: another waiter may have already refreshed
        const current = await tokenStore.get(source);
        if (current && (current.expiresAt ?? 0) - Date.now() >= 60_000) {
          return current;
        }
        const refreshed = await doRefresh(source, current ?? tokens, http, config);
        await tokenStore.set(source, refreshed);
        return refreshed;
      } finally {
        resolveMutex();
        // Clean up in-flight entry after completion
        if (inFlight.get(source) === refreshPromise) {
          inFlight.delete(source);
        }
      }
    });

    inFlight.set(source, refreshPromise);
    const result = await refreshPromise;
    return result.accessToken;
  }

  // Non-rotating: simple single-flight
  const refreshPromise = doRefreshAndPersist(source, tokens, http, config, tokenStore);
  inFlight.set(source, refreshPromise);
  try {
    const result = await refreshPromise;
    return result.accessToken;
  } finally {
    if (inFlight.get(source) === refreshPromise) {
      inFlight.delete(source);
    }
  }
}

async function doRefreshAndPersist(
  source: SourceId,
  tokens: OAuthTokens,
  http: HttpClient,
  config: RefreshConfig,
  tokenStore: TokenStore
): Promise<OAuthTokens> {
  const refreshed = await doRefresh(source, tokens, http, config);
  await tokenStore.set(source, refreshed);
  return refreshed;
}

async function doRefresh(
  _source: SourceId,
  tokens: OAuthTokens,
  http: HttpClient,
  config: RefreshConfig
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken ?? "",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await http.request({
    method: "POST",
    url: config.tokenUrl,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (res.status !== 200) {
    throw new Error(
      `OAuth refresh failed: HTTP ${res.status} — ${JSON.stringify(res.body)}`
    );
  }

  const data = res.body as Record<string, unknown>;
  const expiresIn = (data["expires_in"] as number | undefined) ?? 3600;

  return {
    accessToken: data["access_token"] as string,
    // Rotating refresh: new refresh token is returned; fall back to old one for non-rotating
    refreshToken: (data["refresh_token"] as string | undefined) ?? tokens.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: (data["scope"] as string | undefined) ?? tokens.scope,
  };
}

/** Clear in-flight state (for testing). */
export function clearOAuthState(): void {
  inFlight.clear();
  mutexTail.clear();
}
