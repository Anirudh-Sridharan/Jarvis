/**
 * Tests for services/core/src/mac/commandRunner.ts — hermetic (no TCC grants
 * required, no network), exercised against real short-lived system binaries.
 */

import { describe, it, expect } from "vitest";
import {
  execFileMacRunner,
  makeExecFileMacRunner,
  MAC_COMMAND_TIMEOUT_MAX_MS,
} from "../src/mac/commandRunner.js";

describe("MacCommandRunner (execFile-based)", () => {
  it("a successful /bin/echo call returns exitCode 0, timedOut false, and the echoed stdout", async () => {
    const result = await execFileMacRunner("/bin/echo", ["hello-mac-tools"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("hello-mac-tools");
  });

  it("a non-zero exit (ls on a missing path) reports a non-zero exitCode and stderr, timedOut false", async () => {
    const result = await execFileMacRunner("/bin/ls", [
      "/definitely/does/not/exist/xyz123",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.timedOut).toBe(false);
  });

  it("a call exceeding its timeout reports timedOut true and resolves well under the ~2min undecided-Automation hang (Pitfall 2)", async () => {
    // NOTE: a requested timeoutMs of 150 is itself clamped up to the
    // MAC_COMMAND_TIMEOUT_MIN_MS floor (1000ms, see the clamping test
    // below), so the effective timeout here is ~1000ms, not 150ms. The
    // substantive assertion is timedOut:true resolving in low single-digit
    // seconds, nowhere near the multi-minute undecided-Automation hang this
    // timeout mechanism exists to prevent (15-RESEARCH.md Common Pitfall 2).
    const start = Date.now();
    const result = await execFileMacRunner("/bin/sleep", ["5"], {
      timeoutMs: 150,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("clamps a too-small timeoutMs up to the 1000ms floor, and that floored timeout still resolves in under 1000ms of caller-visible latency for a short-lived command", async () => {
    // sleep 0.3s completes well within the clamped 1000ms floor, even
    // though the caller asked for an impossible 10ms timeout — proving the
    // floor (not the caller's 10ms) governs, and the whole call still
    // resolves comfortably under 1000ms since the command itself finishes
    // fast (no timeout ever fires).
    const start = Date.now();
    const result = await execFileMacRunner("/bin/sleep", ["0.3"], {
      timeoutMs: 10,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(1000);
  });

  it("makeExecFileMacRunner accepts a custom default timeout", async () => {
    const runner = makeExecFileMacRunner(MAC_COMMAND_TIMEOUT_MAX_MS);
    const result = await runner("/bin/echo", ["custom-default"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("custom-default");
  });
});
