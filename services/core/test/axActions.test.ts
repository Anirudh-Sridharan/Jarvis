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
import {
  AxActionRunner,
  isSecureTarget,
  SECURE_FIELD_SUBROLES,
  SECURE_FIELD_ROLES,
} from "../src/mac/axActions.js";
import { formatAxRef, SUBROLE_NONE } from "../src/mac/axSnapshot.js";

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

/** The JXA body an osascript call actually carried (the argv element after -e). */
function scriptBodyOf(call: { args: string[] }): string {
  return call.args[call.args.indexOf("-e") + 1]!;
}

const REF = formatAxRef("TextEdit", [0, 1], "AXTextField");

// ── isSecureTarget (CR-01) ────────────────────────────────────────────────────

describe("isSecureTarget", () => {
  it("true for the shape macOS ACTUALLY emits for a password field: role AXTextField + subrole AXSecureTextField", () => {
    expect(isSecureTarget("AXTextField", "AXSecureTextField")).toBe(true);
    expect(isSecureTarget("axtextfield", "axsecuretextfield")).toBe(true);
  });

  it("true when the secure marker arrives as a ROLE (defensive — macOS does not do this)", () => {
    expect(isSecureTarget("AXSecureTextField", SUBROLE_NONE)).toBe(true);
  });

  it("true for a null/undefined/empty role — fails closed (D-08)", () => {
    expect(isSecureTarget(null, SUBROLE_NONE)).toBe(true);
    expect(isSecureTarget(undefined, SUBROLE_NONE)).toBe(true);
    expect(isSecureTarget("", SUBROLE_NONE)).toBe(true);
  });

  it("true for a text-entry role whose subrole could NOT be read — fails closed (D-08)", () => {
    expect(isSecureTarget("AXTextField", "")).toBe(true);
    expect(isSecureTarget("AXTextArea", undefined)).toBe(true);
    expect(isSecureTarget("AXComboBox", null)).toBe(true);
  });

  it("false for a text-entry role whose subrole is definitively ABSENT — an ordinary text field stays typable", () => {
    expect(isSecureTarget("AXTextField", SUBROLE_NONE)).toBe(false);
    expect(isSecureTarget("AXTextArea", SUBROLE_NONE)).toBe(false);
  });

  it("false for non-text, non-secure roles", () => {
    expect(isSecureTarget("AXButton", SUBROLE_NONE)).toBe(false);
    expect(isSecureTarget("AXButton", "")).toBe(false);
  });

  it("SECURE_FIELD_SUBROLES holds the real macOS constant; the fictitious AXSecureTextArea is gone", () => {
    expect(SECURE_FIELD_SUBROLES).toEqual(["AXSecureTextField"]);
    expect(SECURE_FIELD_ROLES).toEqual(["AXSecureTextField"]);
    expect(JSON.stringify([SECURE_FIELD_SUBROLES, SECURE_FIELD_ROLES])).not.toContain("AXSecureTextArea");
  });
});

// ── type — secure field refusal ─────────────────────────────────────────────────

describe("AxActionRunner.type — secure field refusal", () => {
  it("refuses the REAL macOS password-field shape (role AXTextField + subrole AXSecureTextField), exactly 1 call, no secret text", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(
      JSON.stringify({
        elementRole: "AXTextField",
        elementSubrole: "AXSecureTextField",
        focusedRole: "AXTextField",
        focusedSubrole: "AXSecureTextField",
      }),
    );
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "super-secret-password");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("super-secret-password");
    if (!result.ok) expect(result.error).toMatch(/secure field/i);
  });

  it("refuses when only the FOCUSED element is secure (the addressed element itself is not)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(
      JSON.stringify({
        elementRole: "AXTextField",
        elementSubrole: SUBROLE_NONE,
        focusedRole: "AXTextField",
        focusedSubrole: "AXSecureTextField",
      }),
    );
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

  it("refuses a text field whose SUBROLE could not be read at all (fails closed)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(
      JSON.stringify({
        elementRole: "AXTextField",
        elementSubrole: "",
        focusedRole: "AXTextField",
        focusedSubrole: "",
      }),
    );
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "unreadable-subrole-secret");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("unreadable-subrole-secret");
  });

  it("a non-secure element issues exactly 2 calls, text present only in the second", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(
        JSON.stringify({
          elementRole: "AXTextField",
          elementSubrole: SUBROLE_NONE,
          focusedRole: "AXTextField",
          focusedSubrole: SUBROLE_NONE,
        }),
      ),
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
  it("refuses the real secure-field shape at focus, exactly 1 call, no secret text", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: "AXSecureTextField" }));
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

  it("refuses when the focused text field's subrole could not be read (fails closed)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: "" }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("third-focus-secret");

    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls)).not.toContain("third-focus-secret");
  });

  it("a non-secure focused element issues exactly 2 calls", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: SUBROLE_NONE })),
      ok(JSON.stringify({ success: true })),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("hi there");

    expect(result.ok).toBe(true);
    expect(fake.calls.length).toBe(2);
  });
});

// ── TOCTOU re-verification inside the keystroke call (15 WR-03) ───────────────

describe("AxActionRunner — keystroke-time re-verification", () => {
  it("type passes the inspected role+subrole to the keystroke script so it can re-check them", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(
        JSON.stringify({
          elementRole: "AXTextField",
          elementSubrole: SUBROLE_NONE,
          focusedRole: "AXTextField",
          focusedSubrole: SUBROLE_NONE,
        }),
      ),
      ok(JSON.stringify({ success: true })),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    await runner.type(REF, "hello");

    const keystrokeCall = fake.calls[1]!;
    expect(keystrokeCall.args.slice(-2)).toEqual(["AXTextField", SUBROLE_NONE]);
    const body = scriptBodyOf(keystrokeCall);
    expect(body).toContain("readSubrole");
    expect(body).toContain("isSecureLive");
    expect(body).toContain("focus-changed");
  });

  it("type surfaces a focus-changed refusal from the keystroke script instead of reporting success", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(
        JSON.stringify({
          elementRole: "AXTextField",
          elementSubrole: SUBROLE_NONE,
          focusedRole: "AXTextField",
          focusedSubrole: SUBROLE_NONE,
        }),
      ),
      ok(JSON.stringify({ refused: "focus-changed", liveRole: "AXSheet", liveSubrole: SUBROLE_NONE })),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.type(REF, "hello");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe("focus-changed");
      expect(result.error).toMatch(/AXSheet/);
    }
  });

  it("typeAtFocus surfaces a secure-field refusal raised at keystroke time (focus moved to a password field)", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: SUBROLE_NONE })),
      ok(JSON.stringify({ refused: "secure-field", liveRole: "AXTextField", liveSubrole: "AXSecureTextField" })),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("late-arriving-secret");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refused).toBe("secure-field");
      expect(result.error).toMatch(/secure field/i);
    }
  });

  it("typeAtFocus does not report success when the keystroke script returns no success flag", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: SUBROLE_NONE })),
      ok(JSON.stringify({})),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.typeAtFocus("hello");

    expect(result.ok).toBe(false);
  });

  it("the in-script secure guard is generated from the TS constants, so the two cannot drift", async () => {
    const fake = new FakeMacRunner();
    fake.results = [
      ok(JSON.stringify({ focusedRole: "AXTextField", focusedSubrole: SUBROLE_NONE })),
      ok(JSON.stringify({ success: true })),
    ];
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    await runner.typeAtFocus("hello");

    const body = scriptBodyOf(fake.calls[1]!);
    for (const name of [...SECURE_FIELD_SUBROLES, ...SECURE_FIELD_ROLES]) {
      expect(body).toContain(name.toLowerCase());
    }
    expect(() => new Function(body)).not.toThrow();
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

  it("sends click to a PROCESS with the named at: parameter — never Application('System Events').click({x,y}) (CR-02)", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ success: true }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    await runner.clickAt({ x: 10, y: 20 });

    const body = scriptBodyOf(fake.calls[0]!);
    // Live-verified: Application("System Events").click({x,y}) throws
    // "Can't convert types." at parameter marshalling on every invocation.
    expect(body).not.toMatch(/se\.click\s*\(/);
    expect(body).toContain("processes.whose({ frontmost: true })");
    expect(body).toMatch(/\.click\(\{\s*at:\s*\[x,\s*y\]\s*\}\)/);
  });

  it("every JXA body handed to osascript parses as JavaScript", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ success: true }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    await runner.clickAt({ x: 10, y: 20 });
    await runner.pressKey("Enter");
    await runner.click(REF);

    expect(fake.calls.length).toBe(3);
    for (const call of fake.calls) {
      // JXA is JavaScript — a body that does not parse could never run.
      expect(() => new Function(scriptBodyOf(call))).not.toThrow();
    }
  });

  it("reports ok:false when the click script does not report success", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok(JSON.stringify({ success: false }));
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.clickAt({ x: 10, y: 20 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/did not report success/);
  });

  it("reports ok:false when the click script's stdout is not parseable", async () => {
    const fake = new FakeMacRunner();
    fake.result = ok("not json at all");
    const runner = new AxActionRunner(new ScriptRunner(fake.runner));

    const result = await runner.clickAt({ x: 10, y: 20 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed to parse/);
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

  // 15 WR-05: these are non-undefined on an object literal via the prototype
  // chain, so the old `keyCode === undefined` guard let them through and a
  // spawn occurred for a key the module documents as refused pre-spawn.
  for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    it(`refuses the prototype-chain key "${key}" with zero calls`, async () => {
      const fake = new FakeMacRunner();
      const runner = new AxActionRunner(new ScriptRunner(fake.runner));

      const result = await runner.pressKey(key);

      expect(result.ok).toBe(false);
      expect(fake.calls.length).toBe(0);
    });
  }

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
