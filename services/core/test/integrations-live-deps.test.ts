/**
 * Tests for the real connector dependencies core injects into
 * @jarvis/integrations: FetchHttpClient (injected fetch) and
 * KeychainTokenStore (injected command runner). No network, no keychain.
 */

import { describe, it, expect, vi } from "vitest";
import { FetchHttpClient } from "../src/integrations/fetchHttp.js";
import {
  KeychainTokenStore,
  type CommandResult,
} from "../src/integrations/keychainTokenStore.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FetchHttpClient", () => {
  it("performs a GET and parses a JSON response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const http = new FetchHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await http.request({
      method: "GET",
      url: "https://api.example.com/x",
      headers: { Authorization: "Bearer t" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/x");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer t");
  });

  it("passes string bodies through untouched (form-encoded token requests)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const http = new FetchHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await http.request({
      method: "POST",
      url: "https://oauth.example.com/token",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&refresh_token=r1",
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe("grant_type=refresh_token&refresh_token=r1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("serializes object bodies as JSON and sets Content-Type", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const http = new FetchHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await http.request({
      method: "POST",
      url: "https://api.example.com/y",
      body: { a: 1 },
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("returns non-2xx statuses instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "rate_limited" }));
    const http = new FetchHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await http.request({ method: "GET", url: "https://api.example.com/z" });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "rate_limited" });
  });

  it("leaves non-JSON responses as text", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("plain", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const http = new FetchHttpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await http.request({ method: "GET", url: "https://api.example.com/t" });
    expect(res.body).toBe("plain");
  });
});

describe("KeychainTokenStore", () => {
  function fakeRunner(script: (cmd: string, args: string[]) => CommandResult) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push({ cmd, args });
      return script(cmd, args);
    };
    return { run, calls };
  }

  const tokens = { accessToken: "a", refreshToken: "r", expiresAt: 123, scope: "s" };

  it("round-trips tokens through find/add-generic-password", async () => {
    let stored = "";
    const { run, calls } = fakeRunner((_cmd, args) => {
      if (args[0] === "add-generic-password") {
        stored = args[args.indexOf("-w") + 1] ?? "";
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: `${stored}\n`, stderr: "", exitCode: stored ? 0 : 44 };
    });
    const store = new KeychainTokenStore(run);

    expect(await store.get("whoop")).toBeNull(); // not yet stored

    await store.set("whoop", tokens);
    expect(await store.get("whoop")).toEqual(tokens);

    // service naming convention from the architecture doc
    const setCall = calls.find((c) => c.args[0] === "add-generic-password")!;
    expect(setCall.cmd).toBe("security");
    expect(setCall.args).toContain("com.jarvis.connector.whoop");
    expect(setCall.args).toContain("-U"); // update-in-place for rotation
  });

  it("returns null when the keychain item is missing (exit 44)", async () => {
    const { run } = fakeRunner(() => ({ stdout: "", stderr: "not found", exitCode: 44 }));
    const store = new KeychainTokenStore(run);
    expect(await store.get("gmail")).toBeNull();
  });

  it("throws a actionable error on corrupted payloads", async () => {
    const { run } = fakeRunner(() => ({ stdout: "not-json", stderr: "", exitCode: 0 }));
    const store = new KeychainTokenStore(run);
    await expect(store.get("gcal")).rejects.toThrow(/delete-generic-password/);
  });

  it("throws when persistence fails (never silently drop a rotated token)", async () => {
    const { run } = fakeRunner((_cmd, args) =>
      args[0] === "add-generic-password"
        ? { stdout: "", stderr: "keychain locked", exitCode: 36 }
        : { stdout: "", stderr: "", exitCode: 44 },
    );
    const store = new KeychainTokenStore(run);
    await expect(store.set("whoop", tokens)).rejects.toThrow(/keychain locked/);
  });

  it("delete returns true on success and false when absent", async () => {
    let exists = true;
    const { run } = fakeRunner(() => {
      const code = exists ? 0 : 44;
      exists = false;
      return { stdout: "", stderr: "", exitCode: code };
    });
    const store = new KeychainTokenStore(run);
    expect(await store.delete("whoop")).toBe(true);
    expect(await store.delete("whoop")).toBe(false);
  });
});
