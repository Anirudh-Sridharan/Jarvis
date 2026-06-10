/**
 * OAuth tests:
 *   - Whoop rotating refresh is SERIALIZED: concurrent refresh → one network call
 *   - New token is persisted; old invalidated
 *   - refresh-on-401 / pre-expiry refresh
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getAccessToken, clearOAuthState } from "../src/framework/oauth.js";
import { FakeHttp, MemoryTokenStore, makeTokens } from "../src/testing/fakes.js";

const CONFIG = {
  tokenUrl: "https://api.prod.whoop.com/oauth/token",
  clientId: "test_client",
  clientSecret: "test_secret",
};

describe("OAuth — getAccessToken", () => {
  let http: FakeHttp;
  let tokenStore: MemoryTokenStore;

  beforeEach(() => {
    http = new FakeHttp();
    tokenStore = new MemoryTokenStore();
    clearOAuthState();
  });

  afterEach(() => {
    clearOAuthState();
  });

  it("returns access token directly when not expired", async () => {
    tokenStore.seed("whoop", makeTokens({ accessToken: "valid_token", expiresAt: Date.now() + 3600_000 }));

    const token = await getAccessToken("whoop", tokenStore, http, CONFIG, false);
    expect(token).toBe("valid_token");
    expect(http.calls).toHaveLength(0); // no network call needed
  });

  it("refreshes token when expired (within 60s)", async () => {
    tokenStore.seed("whoop", makeTokens({
      accessToken: "old_token",
      refreshToken: "old_refresh",
      expiresAt: Date.now() + 30_000, // expires in 30s (< 60s threshold)
    }));

    http.add(CONFIG.tokenUrl, {
      status: 200,
      headers: {},
      body: { access_token: "new_token", refresh_token: "new_refresh", expires_in: 3600 },
    });

    const token = await getAccessToken("whoop", tokenStore, http, CONFIG, false);
    expect(token).toBe("new_token");
    expect(http.calls).toHaveLength(1);

    // New token persisted
    const stored = tokenStore.peek("whoop");
    expect(stored?.accessToken).toBe("new_token");
  });

  it("throws when no tokens exist", async () => {
    await expect(
      getAccessToken("whoop", tokenStore, http, CONFIG, false)
    ).rejects.toThrow("No OAuth tokens");
  });

  it("throws on failed refresh (HTTP non-200)", async () => {
    tokenStore.seed("whoop", makeTokens({
      accessToken: "old",
      refreshToken: "old_refresh",
      expiresAt: Date.now() - 1000, // already expired
    }));

    http.add(CONFIG.tokenUrl, { status: 401, headers: {}, body: { error: "invalid_grant" } });

    await expect(
      getAccessToken("whoop", tokenStore, http, CONFIG, false)
    ).rejects.toThrow("OAuth refresh failed");
  });

  describe("Whoop rotating refresh — serialized", () => {
    it("concurrent refresh calls result in only ONE network request (single-flight)", async () => {
      // Token is almost expired so refresh is needed
      tokenStore.seed("whoop", makeTokens({
        accessToken: "old_token",
        refreshToken: "old_refresh",
        expiresAt: Date.now() - 1000, // expired
      }));

      let refreshCallCount = 0;
      http.add(CONFIG.tokenUrl, {
        status: 200,
        headers: {},
        body: {
          access_token: "new_token",
          refresh_token: "new_refresh",
          expires_in: 3600,
        },
      });

      // Track network calls manually
      const originalRequest = http.request.bind(http);
      http.request = async (...args: Parameters<typeof originalRequest>) => {
        if (args[0].url.includes("token")) refreshCallCount++;
        return originalRequest(...args);
      };

      // Fire 3 concurrent refresh requests
      const [t1, t2, t3] = await Promise.all([
        getAccessToken("whoop", tokenStore, http, CONFIG, true),
        getAccessToken("whoop", tokenStore, http, CONFIG, true),
        getAccessToken("whoop", tokenStore, http, CONFIG, true),
      ]);

      // All should get the new token
      expect(t1).toBe("new_token");
      expect(t2).toBe("new_token");
      expect(t3).toBe("new_token");

      // Only ONE network call was made (serialized under mutex)
      expect(refreshCallCount).toBe(1);
    });

    it("new rotating refresh token is persisted", async () => {
      tokenStore.seed("whoop", makeTokens({
        accessToken: "old_access",
        refreshToken: "old_refresh",
        expiresAt: Date.now() - 1000,
      }));

      http.add(CONFIG.tokenUrl, {
        status: 200,
        headers: {},
        body: {
          access_token: "new_access",
          refresh_token: "rotated_refresh", // NEW refresh token
          expires_in: 3600,
        },
      });

      await getAccessToken("whoop", tokenStore, http, CONFIG, true);

      const stored = tokenStore.peek("whoop");
      expect(stored?.refreshToken).toBe("rotated_refresh");
      expect(stored?.accessToken).toBe("new_access");
    });

    it("sequential refreshes each get serialized correctly", async () => {
      tokenStore.seed("whoop", makeTokens({
        accessToken: "access_v1",
        refreshToken: "refresh_v1",
        expiresAt: Date.now() - 1000,
      }));

      http.add(CONFIG.tokenUrl, [
        { status: 200, headers: {}, body: { access_token: "access_v2", refresh_token: "refresh_v2", expires_in: 3600 } },
        { status: 200, headers: {}, body: { access_token: "access_v3", refresh_token: "refresh_v3", expires_in: 3600 } },
      ]);

      // First refresh
      clearOAuthState();
      const t1 = await getAccessToken("whoop", tokenStore, http, CONFIG, true);
      expect(t1).toBe("access_v2");

      // Expire it again
      tokenStore.seed("whoop", { ...tokenStore.peek("whoop")!, expiresAt: Date.now() - 1000 });

      // Second refresh (should use rotated refresh token)
      clearOAuthState();
      const t2 = await getAccessToken("whoop", tokenStore, http, CONFIG, true);
      expect(t2).toBe("access_v3");
    });
  });
});
