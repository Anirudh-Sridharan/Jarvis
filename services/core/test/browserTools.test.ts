/**
 * Browser tools (feature 18 — Playwright MCP slice).
 *
 * Fake-driven: a FakeMcpClient stands in for the live @playwright/mcp
 * subprocess. Covers arg validation, result mapping, snapshot truncation,
 * the degrade-never-crash path, readOnly flags, risk metadata, and registry
 * wiring.
 */

import { describe, it, expect } from "vitest";
import { makeBrowserTools, BROWSER_TEXT_CAP } from "../src/agent/tools/browserTools.js";
import { buildToolRegistry } from "../src/agent/tools/index.js";
import type { McpToolClient, McpToolResult } from "../src/mcp/playwrightMcp.js";
import { getToolMeta } from "@jarvis/agent";
import { createIntegrations } from "@jarvis/integrations";
import {
  FakeHttp,
  MemoryTokenStore,
  FixedClock as IntegrationsFixedClock,
  FakeLlm as IntegrationsFakeLlm,
} from "@jarvis/integrations/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeMcpClient implements McpToolClient {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  nextResult: McpToolResult = { text: "ok", isError: false };
  failWith: Error | null = null;

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.failWith) throw this.failWith;
    this.calls.push({ name, args });
    return this.nextResult;
  }
}

function toolByName(client: McpToolClient, name: string) {
  const tool = makeBrowserTools(client).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not built`);
  return tool;
}

function makeIntegrations() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-browser-tools-test-"));
  return createIntegrations({
    http: new FakeHttp(),
    clock: new IntegrationsFixedClock(),
    tokenStore: new MemoryTokenStore(),
    llm: new IntegrationsFakeLlm(),
    dataDir: dir,
  });
}

// ── Surface + flags ───────────────────────────────────────────────────────────

describe("browser tool surface", () => {
  const NAMES = [
    "browser_navigate",
    "browser_snapshot",
    "browser_go_back",
    "browser_click",
    "browser_type",
    "browser_press_key",
  ];

  it("exposes exactly the six curated tools", () => {
    const tools = makeBrowserTools(new FakeMcpClient());
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("reads are readOnly; interactions are not", () => {
    const tools = makeBrowserTools(new FakeMcpClient());
    const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
    expect(flags["browser_navigate"]).toBe(true);
    expect(flags["browser_snapshot"]).toBe(true);
    expect(flags["browser_go_back"]).toBe(true);
    expect(flags["browser_click"]).toBe(false);
    expect(flags["browser_type"]).toBe(false);
    expect(flags["browser_press_key"]).toBe(false);
  });

  it("registers risk metadata: interactions are browser_action (gated), reads are read_only", () => {
    makeBrowserTools(new FakeMcpClient()); // registration happens at build time
    for (const name of ["browser_click", "browser_type", "browser_press_key"]) {
      const meta = getToolMeta(name);
      expect(meta?.sideEffects).toBe("browser_action");
      expect(meta?.reversible).toBe(false);
    }
    for (const name of ["browser_navigate", "browser_snapshot", "browser_go_back"]) {
      expect(getToolMeta(name)?.sideEffects).toBe("read_only");
    }
  });
});

// ── Behavior ──────────────────────────────────────────────────────────────────

describe("browser tool behavior", () => {
  it("browser_navigate validates the url and forwards to the MCP tool", async () => {
    const client = new FakeMcpClient();
    client.nextResult = { text: "Navigated to https://example.com", isError: false };
    const tool = toolByName(client, "browser_navigate");

    await expect(tool.run({ url: "not a url" })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);

    const result = (await tool.run({ url: "https://example.com" })) as Record<string, unknown>;
    expect(client.calls).toEqual([
      { name: "browser_navigate", args: { url: "https://example.com" } },
    ]);
    expect(result["ok"]).toBe(true);
    expect(String(result["text"])).toContain("example.com");
  });

  it("browser_click forwards element + ref (as target)", async () => {
    const client = new FakeMcpClient();
    const tool = toolByName(client, "browser_click");
    await tool.run({ element: "Login button", ref: "e42" });
    expect(client.calls[0]).toEqual({
      name: "browser_click",
      args: { element: "Login button", target: "e42" },
    });
  });

  it("browser_type forwards text and optional submit", async () => {
    const client = new FakeMcpClient();
    const tool = toolByName(client, "browser_type");
    await tool.run({ element: "Search box", ref: "e7", text: "jarvis", submit: true });
    expect(client.calls[0]!.args).toEqual({
      element: "Search box",
      target: "e7",
      text: "jarvis",
      submit: true,
    });
  });

  it("an MCP isError result becomes ok:false with the message (no throw)", async () => {
    const client = new FakeMcpClient();
    client.nextResult = { text: "Timeout navigating", isError: true };
    const tool = toolByName(client, "browser_navigate");
    const result = (await tool.run({ url: "https://slow.example" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("Timeout");
  });

  it("a throwing client degrades to a structured 'browser unavailable' error", async () => {
    const client = new FakeMcpClient();
    client.failWith = new Error("spawn npx ENOENT");
    const tool = toolByName(client, "browser_snapshot");
    const result = (await tool.run({})) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/browser unavailable/i);
    expect(String(result["error"])).toContain("ENOENT");
  });

  it("oversized snapshot text is capped with a truncation marker", async () => {
    const client = new FakeMcpClient();
    client.nextResult = { text: "x".repeat(BROWSER_TEXT_CAP + 5_000), isError: false };
    const tool = toolByName(client, "browser_snapshot");
    const result = (await tool.run({})) as Record<string, unknown>;
    const text = String(result["text"]);
    expect(text.length).toBeLessThanOrEqual(BROWSER_TEXT_CAP + 50); // cap + marker
    expect(text).toContain("[truncated");
  });
});

// ── Registry wiring ───────────────────────────────────────────────────────────

describe("registry wiring", () => {
  it("buildToolRegistry includes browser tools only when a client is provided", () => {
    const integrations = makeIntegrations();
    const without = buildToolRegistry(integrations);
    expect(without.has("browser_navigate")).toBe(false);

    const withBrowser = buildToolRegistry(integrations, new FakeMcpClient());
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_go_back",
      "browser_click",
      "browser_type",
      "browser_press_key",
    ]) {
      expect(withBrowser.has(name)).toBe(true);
    }
    // Existing tools still present.
    expect(withBrowser.has("web_search")).toBe(true);
    expect(withBrowser.has("email_send")).toBe(true);
  });
});

describe("review fixes", () => {
  it("browser_press_key forwards the key", async () => {
    const client = new FakeMcpClient();
    const tool = toolByName(client, "browser_press_key");
    await expect(tool.run({})).rejects.toThrow(); // key required
    await tool.run({ key: "Enter" });
    expect(client.calls[0]).toEqual({ name: "browser_press_key", args: { key: "Enter" } });
  });

  it("click/type forward the snapshot ref under 'target' (@playwright/mcp schema)", async () => {
    const client = new FakeMcpClient();
    await toolByName(client, "browser_click").run({ element: "Next page", ref: "e14" });
    expect(client.calls[0]!.args).toEqual({ element: "Next page", target: "e14" });

    await toolByName(client, "browser_type").run({ element: "Search", ref: "e7", text: "hi" });
    expect(client.calls[1]!.args).toEqual({ element: "Search", target: "e7", text: "hi" });
  });

  it("navigate rejects non-http(s) URLs", async () => {
    const client = new FakeMcpClient();
    const tool = toolByName(client, "browser_navigate");
    await expect(tool.run({ url: "file:///etc/passwd" })).rejects.toThrow();
    await expect(tool.run({ url: "javascript:alert(1)" })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it("degrade error text is capped too", async () => {
    const client = new FakeMcpClient();
    client.failWith = new Error("x".repeat(BROWSER_TEXT_CAP + 5_000));
    const result = (await toolByName(client, "browser_snapshot").run({})) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(String(result["error"]).length).toBeLessThanOrEqual(BROWSER_TEXT_CAP + 50);
  });

  it("all six tools are marked returnsExternalContent (unconditional taint)", () => {
    for (const tool of makeBrowserTools(new FakeMcpClient())) {
      expect(tool.returnsExternalContent).toBe(true);
    }
  });
});
