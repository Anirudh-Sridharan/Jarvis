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
import { formatAxRef, SUBROLE_NONE } from "../src/mac/axSnapshot.js";
import { MAC_UI_SNAPSHOT_TTL_MS } from "../src/agent/tools/macUiTools.js";
import type { Tool } from "@jarvis/agent";
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

// ── Perception-binding fixtures (15 UF-03) ────────────────────────────────────
//
// Tier 2 acting tools must be bound to a snapshot the same tool set actually
// produced, so every click/type test builds ONE tool set, primes it with a
// snapshot fixture, and then acts.

interface FixtureElement {
  indexPath: number[];
  role: string;
  subrole?: string;
  title?: string;
}

/** The raw AX_SNAPSHOT_SCRIPT stdout shape. */
function snapshotJson(app: string, elements: FixtureElement[]): string {
  return JSON.stringify({
    app,
    window: "Untitled",
    truncated: false,
    elements: elements.map((e) => ({
      indexPath: e.indexPath,
      role: e.role,
      subrole: e.subrole ?? SUBROLE_NONE,
      title: e.title ?? "",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })),
  });
}

/** Build the Tier 2 tool set and prime it with a snapshot the acting tools can
 * bind to. Clears the recorded calls so per-test assertions are about the
 * ACTION, not the priming snapshot. */
async function primedTools(
  fake: FakeMacRunner,
  elements: FixtureElement[],
  opts?: { app?: string; now?: () => number },
): Promise<Tool[]> {
  const tools = makeMacUiTools(fake.runner, opts?.now ? { now: opts.now } : undefined);
  const snapshot = tools.find((t) => t.name === "mac_ui_snapshot")!;
  const previous = fake.result;
  fake.result = ok(snapshotJson(opts?.app ?? "TextEdit", elements));
  const result = (await snapshot.run({})) as Record<string, unknown>;
  if (result["ok"] !== true) throw new Error("snapshot fixture did not succeed");
  fake.result = previous;
  fake.calls.length = 0;
  return tools;
}

function pick(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
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

  it("mac_ui_click's description describes the ROLE re-check honestly, not element identity (15 WR-11)", () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_ui_click");
    // The index path is positional: a same-role element that moved into that
    // position passes. Promising more than that misleads the approver.
    expect(tool.description).toMatch(/role/i);
    expect(tool.description).toMatch(/positional/i);
    expect(tool.description).not.toMatch(/whatever element now occupies that position/i);
  });
});

// ── Secure-field refusal (reachable from the tool surface) ─────────────────────

describe("mac_ui_type — secure field refusal", () => {
  it("refuses typing into a secure field target, no secret text in any recorded argv", async () => {
    const fake = new FakeMacRunner();
    const ref = formatAxRef("TextEdit", [0, 1], "AXTextField");
    const tools = await primedTools(fake, [
      { indexPath: [0, 1], role: "AXTextField", subrole: "AXSecureTextField", title: "Password" },
    ]);
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

    const result = (await pick(tools, "mac_ui_type").run({
      element: "password field",
      ref,
      text: "hunter2",
      submit: false,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/secure field/i);
    expect(JSON.stringify(fake.calls)).not.toContain("hunter2");
  });
});

// ── Perception binding (15 UF-03) ─────────────────────────────────────────────

describe("Tier 2 actions are bound to the snapshot they came from (UF-03)", () => {
  const BUTTON_REF = formatAxRef("TextEdit", [0], "AXButton");
  const SAVE_BUTTON: FixtureElement = { indexPath: [0], role: "AXButton", title: "Save" };

  it("mac_ui_click refuses a ref no snapshot ever produced — zero native calls", async () => {
    const fake = new FakeMacRunner();
    const tools = await primedTools(fake, [SAVE_BUTTON]);

    const result = (await pick(tools, "mac_ui_click").run({
      element: "Save",
      ref: formatAxRef("TextEdit", [7, 7], "AXButton"),
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("mac_ui_snapshot");
    expect(fake.calls.length).toBe(0);
  });

  it("mac_ui_click refuses when the approved description does not match the ref's element", async () => {
    const fake = new FakeMacRunner();
    const tools = await primedTools(fake, [SAVE_BUTTON]);
    fake.result = ok(JSON.stringify({ success: true }));

    // The human would be shown "Delete everything" while the ref points at Save.
    const result = (await pick(tools, "mac_ui_click").run({
      element: "Delete everything",
      ref: BUTTON_REF,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/does not match/i);
    expect(fake.calls.length).toBe(0);
  });

  it("mac_ui_click proceeds when the ref and the description agree with the snapshot", async () => {
    const fake = new FakeMacRunner();
    const tools = await primedTools(fake, [SAVE_BUTTON]);
    fake.result = ok(JSON.stringify({ success: true }));

    const result = (await pick(tools, "mac_ui_click").run({
      element: "the Save button",
      ref: BUTTON_REF,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(fake.calls.length).toBe(1);
  });

  it("mac_ui_type refuses an unbound ref before any spawn — the text never reaches argv", async () => {
    const fake = new FakeMacRunner();
    const tools = await primedTools(fake, [SAVE_BUTTON]);

    const result = (await pick(tools, "mac_ui_type").run({
      element: "search field",
      ref: formatAxRef("TextEdit", [3], "AXTextField"),
      text: "unbound-secret",
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(fake.calls.length).toBe(0);
    expect(JSON.stringify(fake.calls)).not.toContain("unbound-secret");
  });

  it("an element the snapshot gave no title for cannot contradict the description", async () => {
    const fake = new FakeMacRunner();
    const tools = await primedTools(fake, [{ indexPath: [0], role: "AXButton", title: "" }]);
    fake.result = ok(JSON.stringify({ success: true }));

    const result = (await pick(tools, "mac_ui_click").run({
      element: "the untitled toolbar button",
      ref: BUTTON_REF,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
  });

  it("a snapshot older than the TTL no longer binds an action", async () => {
    const fake = new FakeMacRunner();
    let clock = 1_000_000;
    const tools = await primedTools(fake, [SAVE_BUTTON], { now: () => clock });
    fake.result = ok(JSON.stringify({ success: true }));

    clock += MAC_UI_SNAPSHOT_TTL_MS + 1;

    const result = (await pick(tools, "mac_ui_click").run({
      element: "Save",
      ref: BUTTON_REF,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toMatch(/expired/i);
    expect(fake.calls.length).toBe(0);
  });
});

// ── Stale ref ──────────────────────────────────────────────────────────────────

describe("mac_ui_click — stale ref", () => {
  it("refuses a click whose live role no longer matches the ref", async () => {
    const fake = new FakeMacRunner();
    const ref = formatAxRef("TextEdit", [0], "AXButton");
    const tools = await primedTools(fake, [{ indexPath: [0], role: "AXButton", title: "Save" }]);
    fake.result = ok(JSON.stringify({ stale: true, actualRole: "AXStaticText" }));

    const result = (await pick(tools, "mac_ui_click").run({
      element: "save button",
      ref,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("re-run mac_ui_snapshot");
  });
});

describe("mac_ui_type — stale ref (T-15-22)", () => {
  it("refuses typing through a stale ref, and nothing is typed", async () => {
    const fake = new FakeMacRunner();
    const ref = formatAxRef("TextEdit", [0, 1], "AXTextField");
    const tools = await primedTools(fake, [
      { indexPath: [0, 1], role: "AXTextField", title: "Search" },
    ]);
    fake.result = ok(JSON.stringify({ stale: true, actualRole: "AXStaticText" }));

    const result = (await pick(tools, "mac_ui_type").run({
      element: "search field",
      ref,
      text: "stale-target-text",
      submit: false,
    })) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("re-run mac_ui_snapshot");
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("stale-target-text");
  });

  it("mac_ui_type's description states the stale-ref refusal and its positional scope", () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_ui_type");
    expect(tool.description).toMatch(/stale ref is refused/i);
    expect(tool.description).toMatch(/positional/i);
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
