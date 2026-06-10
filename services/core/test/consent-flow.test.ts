/**
 * runConsentFlow end-to-end against a real loopback listener:
 * the "browser" is a fake that immediately GETs the redirect URI the way the
 * provider would, and the token exchange goes through FakeHttp. No real
 * browser, network, or keychain.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeHttp, MemoryTokenStore } from "@jarvis/integrations/testing";
import { runConsentFlow } from "../src/integrations/consentFlow.js";

const PORT = 18976; // test-only port; default 8976 may be in use by a dev flow

function providerRedirect(authorizeUrl: string, params: Record<string, string>): void {
  const url = new URL(authorizeUrl);
  const redirectUri = url.searchParams.get("redirect_uri")!;
  const state = url.searchParams.get("state")!;
  const cb = new URL(redirectUri);
  cb.searchParams.set("state", state);
  for (const [k, v] of Object.entries(params)) cb.searchParams.set(k, v);
  // Fire-and-forget like a browser navigation; the listener resolves the flow.
  void fetch(cb).catch(() => {});
}

describe("runConsentFlow", () => {
  let http: FakeHttp;
  let tokenStore: MemoryTokenStore;

  beforeEach(() => {
    http = new FakeHttp();
    tokenStore = new MemoryTokenStore();
    process.env["WHOOP_CLIENT_ID"] = "w_id";
    process.env["WHOOP_CLIENT_SECRET"] = "w_sec";
    process.env["GMAIL_CLIENT_ID"] = "g_id";
    process.env["GMAIL_CLIENT_SECRET"] = "g_sec";
  });

  afterEach(() => {
    delete process.env["WHOOP_CLIENT_ID"];
    delete process.env["WHOOP_CLIENT_SECRET"];
    delete process.env["GMAIL_CLIENT_ID"];
    delete process.env["GMAIL_CLIENT_SECRET"];
  });

  it("completes the whoop flow: callback → exchange → tokens persisted", async () => {
    http.add("oauth/oauth2/token", {
      status: 200,
      headers: {},
      body: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline" },
    });

    const tokens = await runConsentFlow("whoop", {
      http,
      tokenStore,
      port: PORT,
      timeoutMs: 5_000,
      log: () => {},
      openBrowser: (url) => providerRedirect(url, { code: "auth_code_1" }),
    });

    expect(tokens.accessToken).toBe("at");
    expect(tokenStore.peek("whoop")?.refreshToken).toBe("rt");

    const sent = new URLSearchParams(http.calls[0]!.req.body as string);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("auth_code_1");
    expect(sent.get("redirect_uri")).toBe(`http://127.0.0.1:${PORT}/callback`);
    expect(sent.has("code_verifier")).toBe(false); // whoop: no PKCE
  });

  it("uses PKCE for gmail: challenge on authorize, matching verifier on exchange", async () => {
    http.add("oauth2.googleapis.com/token", {
      status: 200,
      headers: {},
      body: { access_token: "at", refresh_token: "rt", expires_in: 3599 },
    });

    let challenge = "";
    await runConsentFlow("gmail", {
      http,
      tokenStore,
      port: PORT,
      timeoutMs: 5_000,
      log: () => {},
      openBrowser: (url) => {
        challenge = new URL(url).searchParams.get("code_challenge") ?? "";
        providerRedirect(url, { code: "gcode" });
      },
    });

    expect(challenge).not.toBe("");
    const sent = new URLSearchParams(http.calls[0]!.req.body as string);
    const verifier = sent.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(tokenStore.peek("gmail")?.accessToken).toBe("at");
  });

  it("rejects when the provider redirects with an error", async () => {
    await expect(
      runConsentFlow("whoop", {
        http,
        tokenStore,
        port: PORT,
        timeoutMs: 5_000,
        log: () => {},
        openBrowser: (url) => providerRedirect(url, { error: "access_denied" }),
      }),
    ).rejects.toThrow(/access_denied/);

    expect(tokenStore.peek("whoop")).toBeNull();
  });

  it("ignores stray hits (wrong/no state) and still completes on the real callback", async () => {
    http.add("oauth/oauth2/token", {
      status: 200,
      headers: {},
      body: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "offline" },
    });

    const tokens = await runConsentFlow("whoop", {
      http,
      tokenStore,
      port: PORT,
      timeoutMs: 5_000,
      log: () => {},
      openBrowser: (url) => {
        // A bogus hit first (port scan / prefetch / CSRF attempt: wrong state)
        // — it must get a 400 but NOT kill the listener…
        void fetch(`http://127.0.0.1:${PORT}/callback?code=evil&state=WRONG`)
          .then(() => {
            // …so the real consent that arrives afterwards still succeeds.
            providerRedirect(url, { code: "auth_code_real" });
          })
          .catch(() => {});
      },
    });

    expect(tokens.accessToken).toBe("at");
    const sent = new URLSearchParams(http.calls[0]!.req.body as string);
    expect(sent.get("code")).toBe("auth_code_real");
  });

  it("rejects on consent timeout without persisting anything", async () => {
    await expect(
      runConsentFlow("whoop", {
        http,
        tokenStore,
        port: PORT,
        timeoutMs: 200,
        log: () => {},
        openBrowser: () => {}, // user never completes consent
      }),
    ).rejects.toThrow(/Timed out/);
    expect(tokenStore.peek("whoop")).toBeNull();
  });

  it("fails fast with setup instructions when client creds are missing", async () => {
    delete process.env["WHOOP_CLIENT_ID"];
    await expect(
      runConsentFlow("whoop", { http, tokenStore, port: PORT, log: () => {} }),
    ).rejects.toThrow(/WHOOP_CLIENT_ID/);
  });
});
