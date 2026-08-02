/**
 * tccPreflight.test.ts — hermetic coverage for the D-09/15-SC6 preflight
 * probes and the responsible-process ancestry walk. Driven entirely by a
 * command-dispatching FakeMacRunner + FakeFs — zero real macOS calls, zero
 * real disk I/O.
 */

import { describe, it, expect } from "vitest";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { checkMacGrants, describeResponsibleProcess, type PreflightFs } from "../src/mac/tccPreflight.js";

// ── Fakes ─────────────────────────────────────────────────────────────────────

const OK: MacCommandResult = { stdout: "42", stderr: "", exitCode: 0, timedOut: false };

/** Dispatches canned responses per-command, queue-based so repeated calls to
 * the SAME binary (e.g. osascript for both the automation and accessibility
 * probes) return successive configured results in order. */
class FakeMacRunner {
  calls: Array<{ cmd: string; args: string[]; opts?: MacCommandOptions }> = [];
  private queues: Partial<Record<string, MacCommandResult[]>> = {};
  default: MacCommandResult = OK;

  queue(cmd: string, result: MacCommandResult): void {
    (this.queues[cmd] ??= []).push(result);
  }

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    const q = this.queues[cmd];
    if (q && q.length > 0) return q.shift()!;
    return this.default;
  };
}

class FakeFs implements PreflightFs {
  mkdtempCalls: string[] = [];
  rmCalls: Array<{ path: string; opts: { recursive: boolean; force: boolean } }> = [];
  private counter = 0;

  async mkdtemp(prefix: string): Promise<string> {
    this.counter += 1;
    const dir = `${prefix}${this.counter}`;
    this.mkdtempCalls.push(dir);
    return dir;
  }

  async rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void> {
    this.rmCalls.push({ path, opts });
  }
}

const ACCESSIBILITY_DENIED: MacCommandResult = {
  stdout: "",
  stderr: "execution error: osascript is not allowed assistive access. (-25211)",
  exitCode: 1,
  timedOut: false,
};

const SCREEN_RECORDING_DENIED: MacCommandResult = {
  stdout: "",
  stderr: "could not create image from display 0",
  exitCode: 1,
  timedOut: false,
};

// ── checkMacGrants ──────────────────────────────────────────────────────────────

describe("checkMacGrants", () => {
  it("all four probes succeeding yields allGranted: true and four granted:true entries", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    // Ancestry walk terminates after one ps call (ppid 1).
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    const report = await checkMacGrants(fake.runner, fs);

    expect(report.grants).toHaveLength(4);
    expect(report.grants.map((g) => g.grant)).toEqual([
      "automation-system-events",
      "accessibility",
      "screen-recording",
      "shortcuts",
    ]);
    expect(report.grants.every((g) => g.granted)).toBe(true);
    expect(report.grants.every((g) => g.kind === null)).toBe(true);
    expect(report.grants.every((g) => g.remediation === null)).toBe(true);
    expect(report.allGranted).toBe(true);
  });

  it("live-verified mixed state yields the expected per-grant kind values and allGranted: false", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/usr/bin/osascript", OK); // automation-system-events: succeeds
    fake.queue("/usr/bin/osascript", ACCESSIBILITY_DENIED); // accessibility: -25211
    fake.queue("/usr/sbin/screencapture", SCREEN_RECORDING_DENIED); // screen-recording: denied
    fake.queue("/usr/bin/shortcuts", OK); // shortcuts: succeeds
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    const report = await checkMacGrants(fake.runner, fs);

    expect(report.grants.map((g) => g.kind)).toEqual([null, "accessibility-denied", "screen-recording-denied", null]);
    expect(report.allGranted).toBe(false);
    expect(report.grants[1]!.granted).toBe(false);
    expect(report.grants[1]!.remediation).toContain("Accessibility");
    expect(report.grants[2]!.granted).toBe(false);
    expect(report.grants[2]!.remediation).toContain("Screen Recording");
  });

  it("a probe that times out reports automation-undecided-timeout", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/usr/bin/osascript", { stdout: "", stderr: "", exitCode: 1, timedOut: true }); // automation probe times out
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    const report = await checkMacGrants(fake.runner, fs);

    expect(report.grants[0]!.kind).toBe("automation-undecided-timeout");
    expect(report.grants[0]!.granted).toBe(false);
    expect(report.allGranted).toBe(false);
  });

  it("every recorded probe call carries opts.timeoutMs === 5000", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    await checkMacGrants(fake.runner, fs);

    const probeCalls = fake.calls.filter((c) =>
      ["/usr/bin/osascript", "/usr/sbin/screencapture", "/usr/bin/shortcuts"].includes(c.cmd),
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    for (const call of probeCalls) {
      expect(call.opts?.timeoutMs).toBe(5000);
    }
  });

  it("proves probes run sequentially (no Promise.all) via recorded call order", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    await checkMacGrants(fake.runner, fs);

    const probeCalls = fake.calls.filter((c) =>
      ["/usr/bin/osascript", "/usr/sbin/screencapture", "/usr/bin/shortcuts"].includes(c.cmd),
    );
    // automation-system-events (osascript #1), accessibility (osascript #2),
    // screen-recording (screencapture), shortcuts — in that exact order.
    expect(probeCalls.map((c) => c.cmd)).toEqual([
      "/usr/bin/osascript",
      "/usr/bin/osascript",
      "/usr/sbin/screencapture",
      "/usr/bin/shortcuts",
    ]);
  });

  it("the screen-recording probe removes its temp directory on the success path", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    await checkMacGrants(fake.runner, fs);

    expect(fs.mkdtempCalls.length).toBe(1);
    expect(fs.rmCalls.length).toBe(1);
    expect(fs.rmCalls[0]!.path).toBe(fs.mkdtempCalls[0]);
    expect(fs.rmCalls[0]!.opts).toEqual({ recursive: true, force: true });
  });

  it("the screen-recording probe removes its temp directory on the failure path", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/usr/sbin/screencapture", SCREEN_RECORDING_DENIED);
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    const report = await checkMacGrants(fake.runner, fs);

    expect(report.grants[2]!.granted).toBe(false);
    expect(fs.mkdtempCalls.length).toBe(1);
    expect(fs.rmCalls.length).toBe(1);
    expect(fs.rmCalls[0]!.path).toBe(fs.mkdtempCalls[0]);
  });

  it("grant tiers are assigned correctly", async () => {
    const fake = new FakeMacRunner();
    const fs = new FakeFs();
    fake.queue("/bin/ps", { stdout: "1 launchd", stderr: "", exitCode: 0, timedOut: false });

    const report = await checkMacGrants(fake.runner, fs);

    expect(report.grants.map((g) => g.tier)).toEqual([1, 2, 3, 1]);
  });
});

// ── describeResponsibleProcess ──────────────────────────────────────────────────

describe("describeResponsibleProcess", () => {
  it("returns likelyResponsibleApp containing 'Visual Studio Code' for the traced VS Code ancestry", async () => {
    const fake = new FakeMacRunner();
    // Reproduces the live-traced chain: zsh -> claude -> zsh -> Code Helper -> Visual Studio Code 2.app -> launchd (pid 1)
    fake.queue("/bin/ps", { stdout: "2001 zsh", stderr: "", exitCode: 0, timedOut: false });
    fake.queue("/bin/ps", { stdout: "2002 claude", stderr: "", exitCode: 0, timedOut: false });
    fake.queue("/bin/ps", { stdout: "2003 zsh", stderr: "", exitCode: 0, timedOut: false });
    fake.queue("/bin/ps", {
      stdout: "2004 /Applications/Visual Studio Code 2.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    fake.queue("/bin/ps", {
      stdout: "1 /Applications/Visual Studio Code 2.app/Contents/MacOS/Electron",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });

    const info = await describeResponsibleProcess(fake.runner);

    expect(info.likelyResponsibleApp).toContain("Visual Studio Code");
    expect(info.chain.length).toBe(5);
    expect(info.note).toContain("responsible process");
    expect(info.note.toLowerCase()).toContain("consent dialog");
  });

  it("terminates on a fixture where ps returns ppid 1 (no further ps call made)", async () => {
    const fake = new FakeMacRunner();
    fake.queue("/bin/ps", { stdout: "1 zsh", stderr: "", exitCode: 0, timedOut: false });

    const info = await describeResponsibleProcess(fake.runner);

    expect(info.chain.length).toBe(1);
    const psCalls = fake.calls.filter((c) => c.cmd === "/bin/ps");
    expect(psCalls.length).toBe(1);
  });

  it("terminates on a fixture with a genuinely repeating ppid (cyclic ancestry)", async () => {
    const fake = new FakeMacRunner();
    // ps always reports the SAME ppid (999) for whatever pid is queried —
    // a self-referential/cyclic ancestry that never reaches pid 1.
    fake.default = { stdout: "999 loopy", stderr: "", exitCode: 0, timedOut: false };

    const info = await describeResponsibleProcess(fake.runner);

    // First call records the starting pid, moves to ppid 999; second call
    // (querying 999) reports itself as its own parent again — the `seen`
    // set must catch this and stop, well under the 12-level cap.
    expect(info.chain.length).toBeLessThanOrEqual(2);
    const psCalls = fake.calls.filter((c) => c.cmd === "/bin/ps");
    expect(psCalls.length).toBeLessThanOrEqual(2);
  });

  it("terminates at exactly 12 levels for a monotonic ancestry that never repeats or reaches pid 1", async () => {
    const fake = new FakeMacRunner();
    let nextPpid = 100000;
    const originalRunner: MacCommandRunner = async (cmd, args, opts) => {
      fake.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
      if (cmd !== "/bin/ps") return fake.default;
      const ppid = nextPpid;
      nextPpid += 1;
      return { stdout: `${ppid} proc${ppid}`, stderr: "", exitCode: 0, timedOut: false };
    };

    const info = await describeResponsibleProcess(originalRunner);

    expect(info.chain.length).toBe(12);
    const psCalls = fake.calls.filter((c) => c.cmd === "/bin/ps");
    expect(psCalls.length).toBe(12);
  });

  it("terminates cleanly on an unreadable/malformed ps entry", async () => {
    const fake = new FakeMacRunner();
    fake.queue("/bin/ps", { stdout: "not-a-valid-line", stderr: "", exitCode: 0, timedOut: false });

    const info = await describeResponsibleProcess(fake.runner);

    expect(info.chain.length).toBe(0);
    expect(info.likelyResponsibleApp).toBeNull();
  });

  it("terminates cleanly when a ps call itself fails (non-zero exit)", async () => {
    const fake = new FakeMacRunner();
    fake.queue("/bin/ps", { stdout: "", stderr: "ps: no such process", exitCode: 1, timedOut: false });

    const info = await describeResponsibleProcess(fake.runner);

    expect(info.chain.length).toBe(0);
    expect(info.likelyResponsibleApp).toBeNull();
  });

  it("returns null likelyResponsibleApp when no ancestor's command contains a .app/ segment", async () => {
    const fake = new FakeMacRunner();
    fake.queue("/bin/ps", { stdout: "1 zsh", stderr: "", exitCode: 0, timedOut: false });

    const info = await describeResponsibleProcess(fake.runner);

    expect(info.likelyResponsibleApp).toBeNull();
  });
});
