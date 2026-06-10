/**
 * Consent-flow tests:
 *   - PKCE pair generation (S256 relationship, base64url)
 *   - /authorize URL construction per provider (PKCE only where supported)
 *   - callback parsing: code extraction, state mismatch, provider errors
 *   - code→token exchange: body shape, PKCE verifier, error propagation
 *   - oauth.ts refresh sends extraRefreshParams (Whoop scope=offline)
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  parseCallbackUrl,
  exchangeCodeForTokens,
} from "../src/framework/authFlow.js";
import {
  getOAuthProvider,
  getRefreshConfig,
  requireClientCredentials,
  isOAuthSource,
} from "../src/framework/providers.js";
import { getAccessToken, clearOAuthState } from "../src/framework/oauth.js";
import { FakeHttp, MemoryTokenStore, makeTokens } from "../src/testing/fakes.js";

const CREDS = { clientId: "cid", clientSecret: "csec" };
const REDIRECT = "http://127.0.0.1:53682/callback";

describe("PKCE / state", () => {
  it("generates a base64url verifier whose S256 hash matches the challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generates unique state values", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds a Google URL with PKCE + offline access", () => {
    const provider = getOAuthProvider("gmail");
    const url = new URL(
      buildAuthorizeUrl(provider, CREDS, {
        redirectUri: REDIRECT,
        state: "st8",
        codeChallenge: "chal",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("builds a Whoop URL without PKCE params", () => {
    const provider = getOAuthProvider("whoop");
    const url = new URL(
      buildAuthorizeUrl(provider, CREDS, { redirectUri: REDIRECT, state: "st8" }),
    );

    expect(url.origin + url.pathname).toBe("https://api.prod.whoop.com/oauth/oauth2/auth");
    expect(url.searchParams.get("scope")).toContain("offline");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("throws when a PKCE provider is missing the challenge", () => {
    const provider = getOAuthProvider("gcal");
    expect(() =>
      buildAuthorizeUrl(provider, CREDS, { redirectUri: REDIRECT, state: "s" }),
    ).toThrow(/PKCE/);
  });
});

describe("parseCallbackUrl", () => {
  it("extracts the code when state matches", () => {
    const { code } = parseCallbackUrl("/callback?code=abc&state=st8", "st8");
    expect(code).toBe("abc");
  });

  it("rejects a state mismatch", () => {
    expect(() => parseCallbackUrl("/callback?code=abc&state=evil", "st8")).toThrow(
      /state mismatch/i,
    );
  });

  it("surfaces provider errors", () => {
    expect(() =>
      parseCallbackUrl("/callback?error=access_denied&state=st8", "st8"),
    ).toThrow(/access_denied/);
  });

  it("rejects a callback with no code", () => {
    expect(() => parseCallbackUrl("/callback?state=st8", "st8")).toThrow(/missing/i);
  });
});

describe("exchangeCodeForTokens", () => {
  let http: FakeHttp;

  beforeEach(() => {
    http = new FakeHttp();
  });

  it("exchanges a code for tokens (Google, with PKCE verifier)", async () => {
    const provider = getOAuthProvider("gcal");
    http.add(provider.tokenUrl, {
      status: 200,
      headers: {},
      body: {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/calendar.readonly",
      },
    });

    const tokens = await exchangeCodeForTokens(
      provider,
      CREDS,
      { code: "abc", redirectUri: REDIRECT, codeVerifier: "ver" },
      http,
    );

    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    const sent = new URLSearchParams(http.calls[0]!.req.body as string);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("abc");
    expect(sent.get("redirect_uri")).toBe(REDIRECT);
    expect(sent.get("code_verifier")).toBe("ver");
    expect(sent.get("client_secret")).toBe("csec");
  });

  it("omits code_verifier for Whoop", async () => {
    const provider = getOAuthProvider("whoop");
    http.add(provider.tokenUrl, {
      status: 200,
      headers: {},
      body: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
    });

    await exchangeCodeForTokens(provider, CREDS, { code: "abc", redirectUri: REDIRECT }, http);
    const sent = new URLSearchParams(http.calls[0]!.req.body as string);
    expect(sent.has("code_verifier")).toBe(false);
  });

  it("throws on a non-200 exchange", async () => {
    const provider = getOAuthProvider("whoop");
    http.add(provider.tokenUrl, {
      status: 400,
      headers: {},
      body: { error: "invalid_grant" },
    });

    await expect(
      exchangeCodeForTokens(provider, CREDS, { code: "bad", redirectUri: REDIRECT }, http),
    ).rejects.toThrow(/invalid_grant/);
  });
});

describe("providers", () => {
  it("identifies OAuth sources", () => {
    expect(isOAuthSource("whoop")).toBe(true);
    expect(isOAuthSource("gmail")).toBe(true);
    expect(isOAuthSource("apple_health")).toBe(false);
  });

  it("requireClientCredentials throws a setup hint when env is missing", () => {
    delete process.env["WHOOP_CLIENT_ID"];
    delete process.env["WHOOP_CLIENT_SECRET"];
    expect(() => requireClientCredentials(getOAuthProvider("whoop"))).toThrow(
      /WHOOP_CLIENT_ID/,
    );
  });

  it("requireClientCredentials reads env at call time", () => {
    process.env["WHOOP_CLIENT_ID"] = "w_id";
    process.env["WHOOP_CLIENT_SECRET"] = "w_sec";
    try {
      const creds = requireClientCredentials(getOAuthProvider("whoop"));
      expect(creds).toEqual({ clientId: "w_id", clientSecret: "w_sec" });
    } finally {
      delete process.env["WHOOP_CLIENT_ID"];
      delete process.env["WHOOP_CLIENT_SECRET"];
    }
  });
});

describe("refresh with extraRefreshParams", () => {
  let http: FakeHttp;
  let tokenStore: MemoryTokenStore;

  beforeEach(() => {
    http = new FakeHttp();
    tokenStore = new MemoryTokenStore();
    clearOAuthState();
  });

  afterEach(() => clearOAuthState());

  it("whoop refresh sends scope=offline and hits the v2 token URL", async () => {
    const config = getRefreshConfig("whoop");
    expect(config.tokenUrl).toBe("https://api.prod.whoop.com/oauth/oauth2/token");

    tokenStore.seed(
      "whoop",
      makeTokens({ accessToken: "old", refreshToken: "r1", expiresAt: Date.now() + 1000 }),
    );
    http.add(config.tokenUrl, {
      status: 200,
      headers: {},
      body: { access_token: "new", refresh_token: "r2", expires_in: 3600 },
    });

    const token = await getAccessToken("whoop", tokenStore, http, config, true);
    expect(token).toBe("new");

    const sent = new URLSearchParams(http.calls[0]!.req.body as string);
    expect(sent.get("scope")).toBe("offline");
    expect(tokenStore.peek("whoop")?.refreshToken).toBe("r2");
  });
});
