/**
 * axSnapshot.test.ts — Tier 2 AX UI snapshot (phase 15, plan 15-04).
 *
 * Driven entirely by a FakeMacRunner implementing MacCommandRunner (mirrors
 * macRunners.test.ts): it never throws and records every call so the
 * argv-shape and refusal assertions can inspect exactly what was sent to
 * `/usr/bin/osascript`.
 */

import { describe, it, expect } from "vitest";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { ScriptRunner } from "../src/mac/scriptRunner.js";
import { AxSnapshotRunner, formatAxRef, parseAxRef } from "../src/mac/axSnapshot.js";

// ── Fake ──────────────────────────────────────────────────────────────────────

class FakeMacRunner {
  calls: Array<{ cmd: string; args: string[]; opts?: MacCommandOptions }> = [];
  result: MacCommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    return this.result;
  };
}

interface FixtureElement {
  indexPath: number[];
  role: string;
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function fixture(
  elements: FixtureElement[],
  opts: { app?: string; window?: string | null; truncated?: boolean } = {},
): string {
  return JSON.stringify({
    app: opts.app ?? "TextEdit",
    window: opts.window === undefined ? "Untitled" : opts.window,
    truncated: opts.truncated ?? false,
    elements: elements.map((e) => ({
      indexPath: e.indexPath,
      role: e.role,
      title: e.title,
      x: e.x ?? 0,
      y: e.y ?? 0,
      width: e.width ?? 0,
      height: e.height ?? 0,
    })),
  });
}

// ── Ref codec ─────────────────────────────────────────────────────────────────

describe("formatAxRef / parseAxRef", () => {
  it("round-trips app + indexPath + role", () => {
    const ref = formatAxRef("TextEdit", [0, 3, 1], "AXButton");
    expect(ref).toBe("TextEdit#0.3.1#AXButton");
    expect(parseAxRef(ref)).toEqual({ app: "TextEdit", indexPath: [0, 3, 1], role: "AXButton" });
  });

  const malformed = ["TextEdit", "TextEdit#", "TextEdit#0.x.1#AXButton", "#0.1#AXButton"];
  for (const ref of malformed) {
    it(`returns null for malformed ref: ${JSON.stringify(ref)}`, () => {
      expect(parseAxRef(ref)).toBeNull();
    });
  }
});

// ── argv construction ─────────────────────────────────────────────────────────

describe("AxSnapshotRunner.snapshot — argv construction", () => {
  it("places the app name in argv AFTER the -e script body, never inside the script body", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: fixture([{ indexPath: [0], role: "AXButton", title: "Close" }]),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const runner = new AxSnapshotRunner(new ScriptRunner(fake.runner));

    await runner.snapshot({ app: "TextEdit" });

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    const eIndex = call.args.indexOf("-e");
    const appIndex = call.args.indexOf("TextEdit");
    expect(eIndex).toBeGreaterThanOrEqual(0);
    expect(appIndex).toBeGreaterThan(eIndex);
    const scriptBody = call.args[eIndex + 1]!;
    expect(scriptBody).not.toContain("TextEdit");
  });
});

// ── Tree rendering ─────────────────────────────────────────────────────────────

describe("AxSnapshotRunner.snapshot — tree rendering", () => {
  it("renders exactly N lines matching the bracket-ref format for a 3-element fixture", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: fixture([
        { indexPath: [0], role: "AXButton", title: "Close", x: 1, y: 2, width: 10, height: 10 },
        { indexPath: [1], role: "AXStaticText", title: "Hello", x: 20, y: 2, width: 40, height: 10 },
        { indexPath: [1, 0], role: "AXTextField", title: "", x: 25, y: 5, width: 30, height: 8 },
      ]),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const runner = new AxSnapshotRunner(new ScriptRunner(fake.runner));

    const result = await runner.snapshot({ app: "TextEdit" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.tree.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^\s*\[[^\]]+\] AX\w+ /);
    }
  });

  it("renders an unreadable/empty title as an empty string rather than dropping the line", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: fixture([{ indexPath: [0], role: "AXButton", title: "" }]),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const runner = new AxSnapshotRunner(new ScriptRunner(fake.runner));

    const result = await runner.snapshot({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]!.title).toBe("");
    expect(result.tree.split("\n")).toHaveLength(1);
    expect(result.tree).toContain('""');
  });
});

// ── Truncation ─────────────────────────────────────────────────────────────────

describe("AxSnapshotRunner.snapshot — truncation", () => {
  it("passes through truncated:true when the walk hit maxElements", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: fixture([{ indexPath: [0], role: "AXButton", title: "A" }], { truncated: true }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
    const runner = new AxSnapshotRunner(new ScriptRunner(fake.runner));

    const result = await runner.snapshot({ maxElements: 1 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.truncated).toBe(true);
  });
});

// ── TCC degrade ────────────────────────────────────────────────────────────────

describe("AxSnapshotRunner.snapshot — TCC degrade", () => {
  it("maps a -25211 stderr to accessibility-denied with a System Settings remediation", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: "",
      stderr: "osascript is not allowed assistive access. (-25211)",
      exitCode: 1,
      timedOut: false,
    };
    const runner = new AxSnapshotRunner(new ScriptRunner(fake.runner));

    const result = await runner.snapshot({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("accessibility-denied");
      expect(result.error).toContain("Privacy & Security > Accessibility");
    }
  });
});

// ── Malformed stdout ───────────────────────────────────────────────────────────

describe("AxSnapshotRunner.snapshot — malformed stdout", () => {
  it("degrades to a structured error instead of throwing on unparseable stdout", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "not json {{{", stderr: "", exitCode: 0, timedOut: false };
    const runner = new AxSnapshotRunner(new ScriptRunner(fake.runner));

    await expect(runner.snapshot({})).resolves.toMatchObject({ ok: false });
  });
});
