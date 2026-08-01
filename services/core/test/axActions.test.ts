/**
 * axActions.test.ts — Tier 2 gated AX actions (phase 15, plan 15-04).
 *
 * Driven entirely by a FakeMacRunner implementing MacCommandRunner. Supports
 * a queued sequence of results (`results`) so two-call flows (inspect then
 * keystroke) can return different fixture JSON per call, falling back to a
 * single `result` when the queue is empty.
 */

import { describe, it, expect } from "vitest";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { ScriptRunner } from "../src/mac/scriptRunner.js";
import { AxActionRunner, isSecureRole, SECURE_FIELD_ROLES } from "../src/mac/axActions.js";
import { formatAxRef } from "../src/mac/axSnapshot.js";

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

const REF = formatAxRef("TextEdit", [0, 1], "AXTextField");

// ── isSecureRole ──────────────────────────────────────────────────────────────

describe("isSecureRole", () => {
  it("true for both secure roles, any casing", () => {
    expect(isSecureRole("AXSecureTextField")).toBe(true);
    expect(isSecureRole("axsecuretextfield")).toBe(true);
    expect(isSecureRole("AXSECURETEXTAREA")).toBe(true);
  });

  it("true for null/undefined/empty — fails closed (D-08)", () => {
    expect(isSecureRole(null)).toBe(true);
    expect(isSecureRole(undefined)).toBe(true);
    expect(isSecureRole("")).toBe(true);
  });

  it("false for non-secure roles", () => {
    expect(isSecureRole("AXTextField")).toBe(false);
    expect(isSecureRole("AXButton")).toBe(false);
  });

  it("SECURE_FIELD_ROLES lists both secure field roles", () => {
    expect(SECURE_FIELD_ROLES).toEqual(["AXSecureTextField", "AXSecureTextArea"]);
  });
});

// ── type — secure field refusal ─────────────────────────────────────────────────

describe("AxActionRunner.type — secure field refusal", () => {
  it("refuses when the element role is AXSecureTextField, exactly 1 call, no secret text", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ elementRole: "AXSecureTextField", focusedRole: "AXTextField" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "super-secret-password");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("super-secret-password");
    if (!result.ok) expect(result.error).toMatch(/secure field/i);
  });

  it("refuses when only the FOCUSED element's role is secure (element role itself non-secure)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ elementRole: "AXTextField", focusedRole: "AXSecureTextField" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "another-secret");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("another-secret");
  });

  it("refuses when both roles are empty/undeterminable (fails closed)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ elementRole: "", focusedRole: "" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "secret-value");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("secret-value");
  });

  it("a non-secure element issues exactly 2 calls, text present only in the second", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(JSON.stringify({ elementRole: "AXTextField", focusedRole: "AXTextField" })),
      ok(JSON.stringify({ success: true })),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "hello world");

    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBe(2);
    expect(JSON.stringify(fake.calls[0])).not.toContain("hello world");
    expect(JSON.stringify(fake.calls[1])).toContain("hello world");
  });
});

// ── typeAtFocus — secure field refusal ──────────────────────────────────────────

describe("AxActionRunner.typeAtFocus — secure field refusal", () => {
  it("refuses when the focused role is secure, exactly 1 call, no secret text", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ focusedRole: "AXSecureTextArea" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("focus-secret");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("focus-secret");
  });

  it("refuses when the focused role is empty (undeterminable)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ focusedRole: "" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("another-focus-secret");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("another-focus-secret");
  });

  it("a non-secure focused element issues exactly 2 calls", async () => {
    const fake = new FakeMacRunner();
    fake.results = [ok(JSON.stringify({ focusedRole: "AXTextField" })), ok(JSON.stringify({ success: true }))];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("hi there");

    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBe(2);
  });
});

// ── click ──────────────────────────────────────────────────────────────────────

describe("AxActionRunner.click", () => {
  it("returns the stale-ref error and issues exactly one call on role mismatch", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ stale: true, actualRole: "AXStaticText" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.click(REF);

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    if (!result.ok) expect(result.error).toContain("re-run mac_ui_snapshot");
  });

  it("clicks successfully when the live role matches", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ success: true }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.click(REF);

    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBe(1);
  });

  it("issues zero calls for a malformed ref", async () => {
    const fake = new FakeMacRunner();
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.click("not-a-ref");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });
});

describe("AxActionRunner.type — malformed ref", () => {
  it("issues zero calls for a malformed ref", async () => {
    const fake = new FakeMacRunner();
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type("bad-ref", "text");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });
});

// ── clickAt ────────────────────────────────────────────────────────────────────

describe("AxActionRunner.clickAt", () => {
  it("refuses NaN coordinates with zero calls", async () => {
    const fake = new FakeMacRunner();
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.clickAt({ x: NaN, y: 10 });

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses negative coordinates with zero calls", async () => {
    const fake = new FakeMacRunner();
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.clickAt({ x: -5, y: 10 });

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("accepts non-negative integer coordinates", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ success: true }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.clickAt({ x: 10, y: 20 });

    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBe(1);
  });
});

// ── pressKey ───────────────────────────────────────────────────────────────────

describe("AxActionRunner.pressKey", () => {
  it("refuses a disallowed key with zero calls", async () => {
    const fake = new FakeMacRunner();
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.pressKey("F13");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("issues one call for an allowed key", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ success: true }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.pressKey("Enter");

    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBe(1);
  });
});

// ── TCC degrade ────────────────────────────────────────────────────────────────

describe("AxActionRunner — TCC degrade", () => {
  it("a -25211 stderr on click degrades to accessibility-denied", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: "",
      stderr: "osascript is not allowed assistive access. (-25211)",
      exitCode: 1,
      timedOut: false,
    };
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.click(REF);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("accessibility-denied");
  });
});
