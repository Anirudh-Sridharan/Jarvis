/**
 * Tests for services/core/src/mac/tccErrors.ts — table-driven, one behavior
 * per `it()`, in the style of services/agent/test/policy.test.ts. Pure
 * functions, no process spawning, no TCC grants, no network.
 */

import { describe, it, expect } from "vitest";
import {
  classifyTccFailure,
  tccRemediation,
  macFailure,
} from "../src/mac/tccErrors.js";
import type { MacCommandResult } from "../src/mac/commandRunner.js";

function makeResult(overrides: Partial<MacCommandResult> = {}): MacCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 1,
    timedOut: false,
    ...overrides,
  };
}

describe("classifyTccFailure", () => {
  it("maps the accessibility-denied signature (-25211) to accessibility-denied", () => {
    expect(
      classifyTccFailure("osascript is not allowed assistive access. (-25211)", false),
    ).toBe("accessibility-denied");
  });

  it("timedOut wins outright even when stderr contains an accessibility signature (timeout precedence)", () => {
    expect(
      classifyTccFailure("osascript is not allowed assistive access. (-25211)", true),
    ).toBe("automation-undecided-timeout");
  });

  it("maps the automation-denied signature (-1743) to automation-denied", () => {
    expect(
      classifyTccFailure(
        "Not authorized to send Apple events to Contacts. (-1743)",
        false,
      ),
    ).toBe("automation-denied");
  });

  it("maps the screen-recording-denied signature to screen-recording-denied", () => {
    expect(
      classifyTccFailure("could not create image from display", false),
    ).toBe("screen-recording-denied");
  });

  it("maps a shortcut-not-found signature to shortcut-not-found", () => {
    expect(
      classifyTccFailure("No shortcut named 'Foo' found", false),
    ).toBe("shortcut-not-found");
  });

  it("maps a timeout with no stderr text to automation-undecided-timeout", () => {
    expect(classifyTccFailure("", true)).toBe("automation-undecided-timeout");
  });

  it("maps unrecognized stderr to unknown", () => {
    expect(classifyTccFailure("some other failure", false)).toBe("unknown");
  });
});

describe("tccRemediation", () => {
  it("automation-undecided-timeout names the app and the Automation settings path", () => {
    const text = tccRemediation("automation-undecided-timeout", "Contacts");
    expect(text).toContain("Contacts");
    expect(text).toMatch(/Privacy & Security > Automation/);
  });

  it("automation-denied names the Automation settings path", () => {
    expect(tccRemediation("automation-denied")).toContain(
      "Privacy & Security > Automation",
    );
  });

  it("accessibility-denied names the Accessibility path, the responsible-process caveat, and mac-doctor", () => {
    const text = tccRemediation("accessibility-denied");
    expect(text).toContain("Privacy & Security > Accessibility");
    expect(text).toMatch(/not to node or osascript/i);
    expect(text).toContain("mac-doctor");
  });

  it("screen-recording-denied names the Screen Recording path and the responsible-process caveat", () => {
    const text = tccRemediation("screen-recording-denied");
    expect(text).toContain("Privacy & Security > Screen Recording");
    expect(text).toMatch(/not to node or osascript/i);
  });

  it("shortcut-not-found suggests mac_list_shortcuts", () => {
    expect(tccRemediation("shortcut-not-found")).toContain("mac_list_shortcuts");
  });

  it("unknown returns a neutral sentence that does not claim a permission problem", () => {
    expect(tccRemediation("unknown")).not.toContain("Privacy & Security");
  });
});

describe("macFailure", () => {
  it("never returns ok:true and always includes a kind", () => {
    const result = macFailure(makeResult({ stderr: "some other failure" }), {
      command: "osascript",
    });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unknown");
  });

  it("truncates stderr longer than 500 characters and keeps the total error message short", () => {
    const longStderr = "x".repeat(5000);
    const result = macFailure(makeResult({ stderr: longStderr }), {
      command: "test-command",
    });
    expect(result.ok).toBe(false);
    expect(result.error.length).toBeLessThanOrEqual(600);
  });

  it("classifies from the result's stderr + timedOut and includes the remediation text", () => {
    const result = macFailure(
      makeResult({ stderr: "could not create image from display" }),
      { command: "screencapture" },
    );
    expect(result.kind).toBe("screen-recording-denied");
    expect(result.error).toContain("Screen Recording");
  });
});
