/**
 * macUiTools.test.ts — Tier 2 Mac-control UI tools (phase 15, plan 15-04).
 *
 * Fake-driven, mirrors macTools.test.ts: a FakeMacRunner implementing
 * MacCommandRunner stands in for the live execFile-based process boundary.
 * Covers surface/flags/metadata, the mandatory returnsExternalContent taint,
 * the secure-field refusal reachable from the tool surface, the stale-ref
 * case, the degrade-never-crash path, and registry wiring.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMacUiTools } from "../src/agent/tools/macUiTools.js";
import { buildToolRegistry } from "../src/agent/tools/index.js";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { formatAxRef } from "../src/mac/axSnapshot.js";
import { getToolMeta } from "@jarvis/agent";
import { createIntegrations } from "@jarvis/integrations";
import {
  FakeHttp,
  MemoryTokenStore,
  FixedClock as IntegrationsFixedClock,
  FakeLlm as IntegrationsFakeLlm,
} from "@jarvis/integrations/testing";

// ── Fake ──────────────────────────────────────────────────────────────────────

class FakeMacRunner {
  calls: Array<{ cmd: string; args: string[]; opts?: MacCommandOptions }> = [];
  results: MacCommandResult[] = [];
  result: MacCommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    if (this.results.length > 0) return this.results.shift()!;
    return this.result;
  };
}

function ok(stdout: string): MacCommandResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

function toolByName(runner: MacCommandRunner, name: string) {
  const tool = makeMacUiTools(runner).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not built`);
  return tool;
}

const NAMES = ["mac_ui_snapshot", "mac_ui_click", "mac_ui_type", "mac_ui_press_key"];
const TIER1_NAMES = [
  "mac_list_apps",
  "mac_frontmost_app",
  "mac_list_shortcuts",
  "mac_open",
  "mac_run_script",
  "mac_run_shortcut",
];

// ── Surface + flags ───────────────────────────────────────────────────────────

describe("mac ui tool surface", () => {
  it("exposes exactly the four Tier 2 tools", () => {
    const fake = new FakeMacRunner();
    const tools = makeMacUiTools(fake.runner);
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("mac_ui_snapshot is readOnly; the other three are not", () => {
    const fake = new FakeMacRunner();
    const tools = makeMacUiTools(fake.runner);
    const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
    expect(flags["mac_ui_snapshot"]).toBe(true);
    expect(flags["mac_ui_click"]).toBe(false);
    expect(flags["mac_ui_type"]).toBe(false);
    expect(flags["mac_ui_press_key"]).toBe(false);
  });

  it("registers risk metadata: snapshot is read_only, the rest are mac_action", () => {
    const fake = new FakeMacRunner();
    makeMacUiTools(fake.runner); // registration happens at build time
    expect(getToolMeta("mac_ui_snapshot")?.sideEffects).toBe("read_only");
    expect(getToolMeta("mac_ui_snapshot")?.reversible).toBe(true);
    for (const name of ["mac_ui_click", "mac_ui_type", "mac_ui_press_key"]) {
      expect(getToolMeta(name)?.sideEffects).toBe("mac_action");
      expect(getToolMeta(name)?.reversible).toBe(false);
    }
  });

  it("every one of the 4 tools has returnsExternalContent === true", () => {
    const fake = new FakeMacRunner();
    for (const tool of makeMacUiTools(fake.runner)) {
      expect(tool.returnsExternalContent).toBe(true);
    }
  });

  it("mac_ui_type's description states Jarvis never types credentials", () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_ui_type");
    expect(tool.description).toContain("never types credentials");
  });
});

// ── Secure-field refusal (reachable from the tool surface) ─────────────────────

describe("mac_ui_type — secure field refusal", () => {
  it("refuses typing into a secure field target, no secret text in any recorded argv", async () => {
    const fake = new FakeMacRunner();
    // The shape macOS ACTUALLY emits for a password field (15 CR-01): the role
    // is AXTextField and the SUBROLE carries the secure marker.
    fake.result = ok(
      JSON.stringify({
        elementRole: "AXTextField",
        elementSubrole: "AXSecureTextField",
        focusedRole: "AXTextField",
        focusedSubrole: "AXSecureTextField",
      }),
    );
    const tool = toolByName(fake.runner, "mac_ui_type");
    const ref = formatAxRef("TextEdit", [0, 1], "AXTextField");

    const result = (await tool.run({ element: "password field", ref, text: "hunter2", submit: false })) as Record<
      string,
      unknown
    >;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/secure field/i);
    expect(JSON.stringify(fake.calls)).not.toContain("hunter2");
  });
});

// ── Stale ref ──────────────────────────────────────────────────────────────────

describe("mac_ui_click — stale ref", () => {
  it("refuses a click whose live role no longer matches the ref", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ stale: true, actualRole: "AXStaticText" }));
    const tool = toolByName(fake.runner, "mac_ui_click");
    const ref = formatAxRef("TextEdit", [0], "AXButton");

    const result = (await tool.run({ element: "save button", ref })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("re-run mac_ui_snapshot");
  });
});

// ── Degrade, never crash ────────────────────────────────────────────────────────

describe("degrade, never crash", () => {
  it("a -25211 stderr on mac_ui_snapshot degrades to accessibility-denied, no throw", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: "",
      stderr: "osascript is not allowed assistive access. (-25211)",
      exitCode: 1,
      timedOut: false,
    };
    const tool = toolByName(fake.runner, "mac_ui_snapshot");

    const result = (await tool.run({})) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(result["kind"]).toBe("accessibility-denied");
  });
});

// ── Registry wiring ───────────────────────────────────────────────────────────

function makeIntegrations() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mac-ui-tools-test-"));
  return createIntegrations({
    http: new FakeHttp(),
    clock: new IntegrationsFixedClock(),
    tokenStore: new MemoryTokenStore(),
    llm: new IntegrationsFakeLlm(),
    dataDir: dir,
  });
}

describe("registry wiring", () => {
  it("buildToolRegistry includes all four Tier 2 names plus the six Tier 1 names only when a runner is provided", () => {
    const integrations = makeIntegrations();

    const without = buildToolRegistry(integrations, null);
    for (const name of [...NAMES, ...TIER1_NAMES]) {
      expect(without.has(name)).toBe(false);
    }

    const fake = new FakeMacRunner();
    const withMac = buildToolRegistry(integrations, null, fake.runner);
    for (const name of [...NAMES, ...TIER1_NAMES]) {
      expect(withMac.has(name)).toBe(true);
    }
    // Existing tools still present.
    expect(withMac.has("web_search")).toBe(true);
    expect(withMac.has("email_send")).toBe(true);
  });
});
