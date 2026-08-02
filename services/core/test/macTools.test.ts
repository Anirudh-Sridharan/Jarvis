/**
 * macTools.test.ts — Tier 1 Mac-control tools (phase 15).
 *
 * Fake-driven, mirrors browserTools.test.ts: a FakeMacRunner implementing
 * MacCommandRunner stands in for the live execFile-based process boundary.
 * Covers surface/flags/metadata, arg validation, the mac_open readOnly
 * regression guard, the black-box Shortcuts clause, and the degrade-never-
 * crash path.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMacTools, MAC_TEXT_CAP } from "../src/agent/tools/macTools.js";
import { buildToolRegistry } from "../src/agent/tools/index.js";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { getToolMeta, createAgentSystem } from "@jarvis/agent";
import { FakeLlm, FixedClock, ManualApprovalSink, makeToolRegistry } from "@jarvis/agent/testing";
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
  result: MacCommandResult = { stdout: "[]", stderr: "", exitCode: 0, timedOut: false };

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    return this.result;
  };
}

function toolByName(runner: MacCommandRunner, name: string) {
  const tool = makeMacTools(runner).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not built`);
  return tool;
}

const NAMES = [
  "mac_list_apps",
  "mac_frontmost_app",
  "mac_list_shortcuts",
  "mac_open",
  "mac_run_script",
  "mac_run_shortcut",
];

// ── Surface + flags ───────────────────────────────────────────────────────────

describe("mac tool surface", () => {
  it("exposes exactly the six Tier 1 tools", () => {
    const fake = new FakeMacRunner();
    const tools = makeMacTools(fake.runner);
    expect(tools.map((t) => t.name).sort()).toEqual([...NAMES].sort());
  });

  it("reads are readOnly; mac_open, mac_run_script, mac_run_shortcut are not", () => {
    const fake = new FakeMacRunner();
    const tools = makeMacTools(fake.runner);
    const flags = Object.fromEntries(tools.map((t) => [t.name, t.readOnly]));
    expect(flags["mac_list_apps"]).toBe(true);
    expect(flags["mac_frontmost_app"]).toBe(true);
    expect(flags["mac_list_shortcuts"]).toBe(true);
    expect(flags["mac_open"]).toBe(false);
    expect(flags["mac_run_script"]).toBe(false);
    expect(flags["mac_run_shortcut"]).toBe(false);
  });

  it("mac_open is readOnly:false — regression guard against the browser_navigate mis-pattern-match", () => {
    // browserTools.ts's browser_navigate is readOnly:true because --isolated
    // guarantees no cookies/logins. mac_open has no such isolation: it opens
    // the user's REAL, logged-in default browser/apps, so it must NEVER be
    // readOnly, unlike browser_navigate. See 15-RESEARCH.md Anti-Patterns.
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_open");
    expect(tool.readOnly).toBe(false);
  });

  it("registers risk metadata: gated tools are mac_action, reads are read_only", () => {
    const fake = new FakeMacRunner();
    makeMacTools(fake.runner); // registration happens at build time
    for (const name of ["mac_open", "mac_run_script", "mac_run_shortcut"]) {
      const meta = getToolMeta(name);
      expect(meta?.sideEffects).toBe("mac_action");
      expect(meta?.reversible).toBe(false);
    }
    for (const name of ["mac_list_apps", "mac_frontmost_app", "mac_list_shortcuts"]) {
      const meta = getToolMeta(name);
      expect(meta?.sideEffects).toBe("read_only");
      expect(meta?.reversible).toBe(true);
    }
  });

  it("the Tier 1 tools that can return app-controlled content are tainted (15 WR-04)", () => {
    const fake = new FakeMacRunner();
    const flags = Object.fromEntries(
      makeMacTools(fake.runner).map((t) => [t.name, t.returnsExternalContent === true]),
    );
    // Script stdout is arbitrary app/document/web content read through a
    // scripting dictionary; a window title is app-controlled text.
    expect(flags["mac_run_script"]).toBe(true);
    expect(flags["mac_frontmost_app"]).toBe(true);
    // Names the OS and the user chose — no app-controlled payload.
    expect(flags["mac_list_apps"]).toBe(false);
    expect(flags["mac_list_shortcuts"]).toBe(false);
  });

  it("mac_run_script's description states the residual shell capability honestly (15 CR-03)", () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_script");
    // The approver must be told a script CAN reach a shell — the old
    // "Shell access is refused" wording was false and made approval uninformed.
    expect(tool.description).toMatch(/can ultimately reach a shell/i);
    expect(tool.description).not.toMatch(/shell access is refused/i);
    expect(tool.description).toMatch(/not a guarantee/i);
  });

  it("mac_run_shortcut's description states the black-box clause (Pitfall 4 / T-15-11)", () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_shortcut");
    expect(tool.description).toContain("not inspectable");
  });
});

// ── Behavior: reads ────────────────────────────────────────────────────────────

describe("mac tool behavior — reads", () => {
  it("mac_list_apps parses the JXA JSON array into apps", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: JSON.stringify(["Finder", "TextEdit"]), stderr: "", exitCode: 0, timedOut: false };
    const tool = toolByName(fake.runner, "mac_list_apps");
    const result = (await tool.run({})) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["apps"]).toEqual(["Finder", "TextEdit"]);
    expect(fake.calls[0]!.cmd).toBe("/usr/bin/osascript");
  });

  it("mac_frontmost_app returns app + window on full success", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: JSON.stringify({ app: "TextEdit", window: "Untitled", windowError: null }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const tool = toolByName(fake.runner, "mac_frontmost_app");
    const result = (await tool.run({})) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["app"]).toBe("TextEdit");
    expect(result["window"]).toBe("Untitled");
  });

  it("mac_frontmost_app degrades window access without failing the whole call", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: JSON.stringify({
        app: "TextEdit",
        window: null,
        windowError: "osascript is not allowed assistive access. (-25211)",
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const tool = toolByName(fake.runner, "mac_frontmost_app");
    const result = (await tool.run({})) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["app"]).toBe("TextEdit");
    expect(result["window"]).toBeNull();
    expect(result["windowUnavailable"]).toBe("accessibility-denied");
    // IN-02: the description promises a remediation, not just the kind enum.
    expect(String(result["windowRemediation"])).toContain("Privacy & Security > Accessibility");
  });

  it("mac_list_shortcuts delegates to ShortcutsRunner.list()", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "Make Coffee\nMorning Routine\n", stderr: "", exitCode: 0, timedOut: false };
    const tool = toolByName(fake.runner, "mac_list_shortcuts");
    const result = (await tool.run({})) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["shortcuts"]).toEqual(["Make Coffee", "Morning Routine"]);
  });
});

// ── Behavior: mac_open validation ──────────────────────────────────────────────

describe("mac_open — Zod validation", () => {
  it("rejects an empty target object", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_open");
    await expect(tool.run({})).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
  });

  it("rejects two conflicting primary targets", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_open");
    await expect(tool.run({ url: "https://example.com", bundleId: "com.apple.Safari" })).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
  });

  it("accepts app + path together", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_open");
    const result = (await tool.run({ app: "TextEdit", path: "/tmp/x.txt" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(fake.calls[0]).toEqual({ cmd: "/usr/bin/open", args: ["-a", "TextEdit", "/tmp/x.txt"] });
  });

  it("rejects an empty-string target (IN-06) with 0 calls", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_open");
    // "" is not undefined, so it counted as a provided target and reached
    // `open -a ""`.
    await expect(tool.run({ app: "" })).rejects.toThrow();
    await expect(tool.run({ bundleId: "" })).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
  });

  it("a file: URL passes Zod but is refused by OpenRunner pre-spawn (0 calls)", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_open");
    const result = (await tool.run({ url: "file:///etc/passwd" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(fake.calls.length).toBe(0);
  });
});

// ── Behavior: mac_run_script ────────────────────────────────────────────────────

describe("mac_run_script", () => {
  it("runs a javascript (JXA) script and returns capped stdout", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "hello", stderr: "", exitCode: 0, timedOut: false };
    const tool = toolByName(fake.runner, "mac_run_script");
    const result = (await tool.run({
      language: "javascript",
      script: 'function run(argv) { return argv[0]; }',
      args: ["hello"],
    })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["stdout"]).toBe("hello");
    const call = fake.calls[0]!;
    expect(call.args[0]).toBe("-l");
    expect(call.args[4]).toBe("hello");
  });

  it("runs an applescript script", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_script");
    await tool.run({ language: "applescript", script: "return 1" });
    const call = fake.calls[0]!;
    expect(call.args[0]).toBe("-e");
  });

  it("refuses a shell-laundering script before any spawn", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_script");
    const result = (await tool.run({
      language: "javascript",
      script: 'app.doShellScript("rm -rf /")',
    })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("rejects an invalid language via Zod", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_script");
    await expect(tool.run({ language: "python", script: "1" })).rejects.toThrow();
  });
});

// ── Behavior: mac_run_shortcut ──────────────────────────────────────────────────

describe("mac_run_shortcut", () => {
  it("runs the named shortcut", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_shortcut");
    const result = (await tool.run({ name: "Make Coffee" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(fake.calls[0]).toEqual({ cmd: "/usr/bin/shortcuts", args: ["run", "Make Coffee"] });
  });

  it("rejects an empty name via Zod", async () => {
    const fake = new FakeMacRunner();
    const tool = toolByName(fake.runner, "mac_run_shortcut");
    await expect(tool.run({ name: "" })).rejects.toThrow();
  });
});

// ── Degrade, never crash ────────────────────────────────────────────────────────

describe("degrade, never crash", () => {
  it("a -25211 stderr yields ok:false with an Accessibility remediation, no throw", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: "",
      stderr: "osascript is not allowed assistive access. (-25211)",
      exitCode: 1,
      timedOut: false,
    };
    const tool = toolByName(fake.runner, "mac_run_script");
    const result = (await tool.run({ language: "javascript", script: "function run(argv){return 1;}" })) as Record<
      string,
      unknown
    >;
    expect(result["ok"]).toBe(false);
    expect(String(result["error"])).toContain("Accessibility");
  });

  it("a timedOut runner result on mac_open degrades to a structured error", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "", stderr: "", exitCode: 1, timedOut: true };
    const tool = toolByName(fake.runner, "mac_open");
    const result = (await tool.run({ app: "Contacts" })) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["kind"]).toBe("automation-undecided-timeout");
  });

  it("oversized mac_run_script stdout is capped ONCE and reports the real number of dropped chars (WR-06)", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "x".repeat(MAC_TEXT_CAP + 5_000), stderr: "", exitCode: 0, timedOut: false };
    const tool = toolByName(fake.runner, "mac_run_script");
    const result = (await tool.run({ language: "javascript", script: "function run(argv){return 1;}" })) as Record<
      string,
      unknown
    >;
    const stdout = String(result["stdout"]);
    expect(stdout.length).toBeLessThanOrEqual(MAC_TEXT_CAP + 50);
    // Exactly one truncation notice, and it names the 5,000 characters that
    // were actually lost — double-capping reported 23.
    expect(stdout.match(/\[truncated /g)).toHaveLength(1);
    expect(stdout).toContain("[truncated 5000 chars]");
    expect(stdout.endsWith("[truncated 5000 chars]")).toBe(true);
  });
});

// ── Registry wiring ───────────────────────────────────────────────────────────

function makeIntegrations() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-mac-tools-test-"));
  return createIntegrations({
    http: new FakeHttp(),
    clock: new IntegrationsFixedClock(),
    tokenStore: new MemoryTokenStore(),
    llm: new IntegrationsFakeLlm(),
    dataDir: dir,
  });
}

describe("registry wiring", () => {
  it("buildToolRegistry includes the six mac tools only when a runner is provided", () => {
    const integrations = makeIntegrations();

    const without = buildToolRegistry(integrations, null);
    for (const name of NAMES) {
      expect(without.has(name)).toBe(false);
    }

    const fake = new FakeMacRunner();
    const withMac = buildToolRegistry(integrations, null, fake.runner);
    for (const name of NAMES) {
      expect(withMac.has(name)).toBe(true);
    }
    // Existing tools still present.
    expect(withMac.has("web_search")).toBe(true);
    expect(withMac.has("email_send")).toBe(true);
  });
});

// ── Approval ordering (15-SC2) ──────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-mac-tools-approval-test-"));
}

/** FakeLlm scripted to call one tool once, then emit __done__. */
function scriptedLlm(toolName: string, args: Record<string, unknown>): FakeLlm {
  return new FakeLlm().setScript([
    JSON.stringify({ tool: toolName, args }),
    JSON.stringify({ tool: "__done__", args: { result: "completed" } }),
  ]);
}

describe("approval ordering — no native command runs before a human approves (15-SC2)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("mac_open pauses for approval; zero calls before approve, exactly one /usr/bin/open call after", async () => {
    tmpDir = makeTempDir();

    const fake = new FakeMacRunner();
    const tools = makeToolRegistry(makeMacTools(fake.runner));
    const llm = scriptedLlm("mac_open", { app: "TextEdit" });
    const clock = new FixedClock(Date.now());
    const manualSink = new ManualApprovalSink();

    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: manualSink.sink,
    });

    const runPromise = agentSystem.agent.run("open TextEdit", { source: "manual" });

    // Wait for the approval request to arrive.
    await new Promise((r) => setTimeout(r, 50));
    expect(manualSink.requests.length).toBeGreaterThanOrEqual(1);
    // No native command has run yet — the run is awaiting approval.
    expect(fake.calls.length).toBe(0);

    const requestId = manualSink.requests[0]!.id;
    manualSink.approve(requestId, "test-user");

    await runPromise;

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.cmd).toBe("/usr/bin/open");
  });

  it("rejecting mac_open leaves the runner untouched", async () => {
    tmpDir = makeTempDir();

    const fake = new FakeMacRunner();
    const tools = makeToolRegistry(makeMacTools(fake.runner));
    const llm = new FakeLlm().setScript([
      JSON.stringify({ tool: "mac_open", args: { app: "TextEdit" } }),
      JSON.stringify({ tool: "__done__", args: { result: "aborted" } }),
      JSON.stringify({ tool: "__done__", args: { result: "aborted" } }),
      JSON.stringify({ tool: "__done__", args: { result: "aborted" } }),
    ]);
    const clock = new FixedClock(Date.now());
    const manualSink = new ManualApprovalSink();

    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: manualSink.sink,
    });

    const runPromise = agentSystem.agent.run("open TextEdit", { source: "manual" });

    await new Promise((r) => setTimeout(r, 50));
    expect(manualSink.requests.length).toBeGreaterThanOrEqual(1);

    const requestId = manualSink.requests[0]!.id;
    manualSink.reject(requestId, "test-user");

    await runPromise;

    expect(fake.calls.length).toBe(0);
  });

  it("a mac_list_apps (readOnly) goal completes with zero approval requests", async () => {
    tmpDir = makeTempDir();

    const fake = new FakeMacRunner();
    fake.result = { stdout: "[]", stderr: "", exitCode: 0, timedOut: false };
    const tools = makeToolRegistry(makeMacTools(fake.runner));
    const llm = scriptedLlm("mac_list_apps", {});
    const clock = new FixedClock(Date.now());
    const manualSink = new ManualApprovalSink();

    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: manualSink.sink,
    });

    const result = await agentSystem.agent.run("list running apps", { source: "manual" });

    expect(result.run.status).toBe("done");
    expect(manualSink.requests.length).toBe(0);
    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
  });
});
