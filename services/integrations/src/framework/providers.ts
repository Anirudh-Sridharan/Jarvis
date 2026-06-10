/**
 * OAuth provider catalog — single source of truth for the OAuth2 providers
 * Jarvis connects to (see architecture/auth-and-integrations.md §2–3).
 *
 * Client credentials come from env vars (loaded from .env by core's loadEnv);
 * tokens themselves are persisted via the injected TokenStore (Keychain in
 * production, MemoryTokenStore in tests).
 *
 * Notes per provider:
 *  - whoop: v2 OAuth endpoints (/oauth/oauth2/*). Rotating refresh tokens —
 *    every refresh invalidates the previous refresh token, and the refresh
 *    request must re-send `scope=offline` to keep receiving refresh tokens.
 *  - gcal/gmail: Google authorization-code flow for installed apps. PKCE plus
 *    `access_type=offline&prompt=consent` so a refresh token is issued.
 */

import type { SourceId } from "../types.js";

export type OAuthSourceId = Extract<SourceId, "whoop" | "gcal" | "gmail">;

export interface OAuthProviderConfig {
  source: OAuthSourceId;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Send PKCE code_challenge/code_verifier (Google supports it; Whoop does not). */
  pkce: boolean;
  /** Rotating refresh tokens — refresh must be serialized (Whoop). */
  rotatingRefresh: boolean;
  /** Extra query params for the /authorize redirect. */
  extraAuthParams?: Record<string, string>;
  /** Extra body params for refresh_token grants (Whoop requires scope=offline). */
  extraRefreshParams?: Record<string, string>;
}

const PROVIDERS: Record<OAuthSourceId, OAuthProviderConfig> = {
  whoop: {
    source: "whoop",
    displayName: "Whoop",
    authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
    tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
    scopes: [
      "read:recovery",
      "read:sleep",
      "read:cycles",
      "read:workout",
      "read:profile",
      "offline",
    ],
    clientIdEnv: "WHOOP_CLIENT_ID",
    clientSecretEnv: "WHOOP_CLIENT_SECRET",
    pkce: false,
    rotatingRefresh: true,
    extraRefreshParams: { scope: "offline" },
  },
  gcal: {
    source: "gcal",
    displayName: "Google Calendar",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    clientIdEnv: "GCAL_CLIENT_ID",
    clientSecretEnv: "GCAL_CLIENT_SECRET",
    pkce: true,
    rotatingRefresh: false,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
  gmail: {
    source: "gmail",
    displayName: "Gmail",
    // gmail.readonly (not gmail.metadata): the connector uses q= search on
    // messages.list, which the metadata scope does not permit.
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    clientIdEnv: "GMAIL_CLIENT_ID",
    clientSecretEnv: "GMAIL_CLIENT_SECRET",
    pkce: true,
    rotatingRefresh: false,
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  },
};

export function getOAuthProvider(source: OAuthSourceId): OAuthProviderConfig {
  const p = PROVIDERS[source];
  if (!p) throw new Error(`Unknown OAuth provider: ${source}`);
  return p;
}

export function isOAuthSource(source: string): source is OAuthSourceId {
  return source === "whoop" || source === "gcal" || source === "gmail";
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Read client credentials from env at call time (NOT module load, so core's
 * loadEnv ordering and test env stubs both work).
 *
 * Throws with setup instructions when missing — used by the consent flow,
 * where placeholder credentials would only produce a confusing provider error.
 */
export function requireClientCredentials(
  provider: OAuthProviderConfig,
): ClientCredentials {
  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing ${provider.displayName} OAuth credentials. ` +
        `Set ${provider.clientIdEnv} and ${provider.clientSecretEnv} in .env ` +
        `(see architecture/auth-and-integrations.md §7 for per-provider setup).`,
    );
  }
  return { clientId, clientSecret };
}

/**
 * Refresh config for getAccessToken(). Falls back to placeholder credentials
 * (matching the previous per-connector behavior) so token-seeded tests run
 * without env vars; a live refresh with placeholders fails at the provider.
 */
export function getRefreshConfig(source: OAuthSourceId): {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  extraRefreshParams?: Record<string, string>;
} {
  const p = getOAuthProvider(source);
  return {
    tokenUrl: p.tokenUrl,
    clientId: process.env[p.clientIdEnv] ?? `${source}_client`,
    clientSecret: process.env[p.clientSecretEnv] ?? `${source}_secret`,
    extraRefreshParams: p.extraRefreshParams,
  };
}
