/**
 * OAuth2 authorization-code consent flow (the *initial* grant).
 *
 * This module owns the protocol logic — PKCE generation, /authorize URL
 * construction, callback parsing, and the code→token exchange — all pure or
 * driven through the injected HttpClient, so it is fully testable with fakes.
 *
 * The runtime plumbing (loopback HTTP listener, opening the browser, Keychain
 * persistence) lives in @jarvis/core's connect CLI, which calls into here.
 * See architecture/auth-and-integrations.md §3.
 */

import { createHash, randomBytes } from "node:crypto";
import type { HttpClient, OAuthTokens } from "../types.js";
import {
  type OAuthProviderConfig,
  type ClientCredentials,
} from "./providers.js";

// ── PKCE / state ──────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string; // S256(verifier), base64url
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(16).toString("base64url");
}

// ── Authorize URL ─────────────────────────────────────────────────────────────

export interface AuthorizeUrlArgs {
  redirectUri: string;
  state: string;
  /** Required when provider.pkce is true. */
  codeChallenge?: string;
}

export function buildAuthorizeUrl(
  provider: OAuthProviderConfig,
  creds: ClientCredentials,
  args: AuthorizeUrlArgs,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: args.redirectUri,
    scope: provider.scopes.join(" "),
    state: args.state,
  });

  if (provider.pkce) {
    if (!args.codeChallenge) {
      throw new Error(`${provider.source} requires PKCE: missing codeChallenge`);
    }
    params.set("code_challenge", args.codeChallenge);
    params.set("code_challenge_method", "S256");
  }

  for (const [k, v] of Object.entries(provider.extraAuthParams ?? {})) {
    params.set(k, v);
  }

  return `${provider.authorizeUrl}?${params}`;
}

// ── Callback parsing ──────────────────────────────────────────────────────────

export interface CallbackResult {
  code: string;
}

/**
 * Parse and validate the provider's redirect back to the loopback listener.
 * Throws on provider-reported errors and on state mismatch (CSRF guard).
 */
export function parseCallbackUrl(
  callbackUrl: string,
  expectedState: string,
): CallbackResult {
  const url = new URL(callbackUrl, "http://127.0.0.1");
  const err = url.searchParams.get("error");
  if (err) {
    const desc = url.searchParams.get("error_description");
    throw new Error(`OAuth consent failed: ${err}${desc ? ` — ${desc}` : ""}`);
  }

  const state = url.searchParams.get("state");
  if (state !== expectedState) {
    throw new Error("OAuth state mismatch — possible CSRF; aborting consent.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("OAuth callback missing authorization code.");
  }
  return { code };
}

// ── Code → token exchange ─────────────────────────────────────────────────────

export interface ExchangeArgs {
  code: string;
  redirectUri: string;
  /** Must match the verifier whose challenge was sent on /authorize. */
  codeVerifier?: string;
}

export async function exchangeCodeForTokens(
  provider: OAuthProviderConfig,
  creds: ClientCredentials,
  args: ExchangeArgs,
  http: HttpClient,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  if (provider.pkce) {
    if (!args.codeVerifier) {
      throw new Error(`${provider.source} requires PKCE: missing codeVerifier`);
    }
    body.set("code_verifier", args.codeVerifier);
  }

  const res = await http.request({
    method: "POST",
    url: provider.tokenUrl,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (res.status !== 200) {
    throw new Error(
      `Token exchange failed for ${provider.source}: HTTP ${res.status} — ${JSON.stringify(res.body)}`,
    );
  }

  const data = res.body as Record<string, unknown>;
  const accessToken = data["access_token"] as string | undefined;
  if (!accessToken) {
    throw new Error(
      `Token exchange for ${provider.source} returned no access_token: ${JSON.stringify(res.body)}`,
    );
  }
  const expiresIn = (data["expires_in"] as number | undefined) ?? 3600;

  return {
    accessToken,
    refreshToken: data["refresh_token"] as string | undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: (data["scope"] as string | undefined) ?? provider.scopes.join(" "),
  };
}
