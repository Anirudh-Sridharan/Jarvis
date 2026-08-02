/**
 * macRunners.test.ts — Tier 1 native runners (open, script, shortcuts).
 *
 * Driven entirely by a FakeMacRunner implementing MacCommandRunner: it never
 * throws (matching the real contract) and records every call so refusal
 * paths can assert `calls.length === 0`.
 */

import { describe, it, expect } from "vitest";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "../src/mac/commandRunner.js";
import { OpenRunner } from "../src/mac/openRunner.js";
import {
  ScriptRunner,
  SHELL_LAUNDERING_PATTERNS,
  rejectShellLaundering,
  delaunderSource,
} from "../src/mac/scriptRunner.js";
import { ShortcutsRunner } from "../src/mac/shortcutsRunner.js";

// ── Fake ──────────────────────────────────────────────────────────────────────

class FakeMacRunner {
  calls: Array<{ cmd: string; args: string[]; opts?: MacCommandOptions }> = [];
  result: MacCommandResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false };

  readonly runner: MacCommandRunner = async (cmd, args, opts) => {
    this.calls.push(opts !== undefined ? { cmd, args, opts } : { cmd, args });
    return this.result;
  };
}

// ── OpenRunner ────────────────────────────────────────────────────────────────

describe("OpenRunner.open — argv construction per target form", () => {
  it("app only -> [-a, app]", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ app: "TextEdit" });
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/open", args: ["-a", "TextEdit"] }]);
  });

  it("bundleId only -> [-b, bundleId]", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ bundleId: "com.apple.TextEdit" });
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/open", args: ["-b", "com.apple.TextEdit"] }]);
  });

  it("http(s) url only -> [url]", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ url: "https://example.com" });
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/open", args: ["https://example.com"] }]);
  });

  it("absolute path only -> [path]", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ path: "/tmp/test.txt" });
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/open", args: ["/tmp/test.txt"] }]);
  });

  it("app + path -> [-a, app, path] (never --args)", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ app: "TextEdit", path: "/tmp/test.txt" });
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/open", args: ["-a", "TextEdit", "/tmp/test.txt"] }]);
    expect(fake.calls[0]!.args).not.toContain("--args");
  });
});

describe("OpenRunner.open — refusal paths never touch the runner", () => {
  it("refuses a file: URL", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ url: "file:///etc/passwd" });
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses a javascript: URL", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ url: "javascript:alert(1)" });
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses a shortcuts: URL", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ url: "shortcuts://run-shortcut?name=x" });
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses a relative path", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ path: "relative/test.txt" });
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses a value starting with -", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ app: "-a" });
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses an invalid combination (url + bundleId)", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ url: "https://example.com", bundleId: "com.apple.Safari" });
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses when no target is provided", async () => {
    const fake = new FakeMacRunner();
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({});
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });
});

describe("OpenRunner.open — TCC degrade", () => {
  it("maps a timedOut result to automation-undecided-timeout", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "", stderr: "", exitCode: 1, timedOut: true };
    const runner = new OpenRunner(fake.runner);
    const result = await runner.open({ app: "Contacts" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("automation-undecided-timeout");
  });
});

// ── ScriptRunner ──────────────────────────────────────────────────────────────

describe("ScriptRunner.runJxa — argv-only data passing", () => {
  it("places the fixed script body at argv index 3 and data at argv index 4, byte-for-byte", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "got:hello; rm -rf /tmp/nope", stderr: "", exitCode: 0, timedOut: false };
    const runner = new ScriptRunner(fake.runner);
    const scriptBody = 'function run(argv) { return "got:" + argv[0]; }';
    const dangerousData = "hello; rm -rf /tmp/nope";

    const result = await runner.runJxa(scriptBody, [dangerousData]);

    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.cmd).toBe("/usr/bin/osascript");
    expect(call.args[0]).toBe("-l");
    expect(call.args[1]).toBe("JavaScript");
    expect(call.args[2]).toBe("-e");
    expect(call.args[3]).toBe(scriptBody);
    expect(call.args[4]).toBe(dangerousData);
  });

  it("returns trimmed stdout on success", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "  hello world  \n", stderr: "", exitCode: 0, timedOut: false };
    const runner = new ScriptRunner(fake.runner);
    const result = await runner.runJxa("function run(argv){return argv[0];}", ["x"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stdout).toBe("hello world");
  });
});

describe("ScriptRunner.runAppleScript — argv shape", () => {
  it("invokes osascript with -e <body> then trailing argv (no -l JavaScript)", async () => {
    const fake = new FakeMacRunner();
    const runner = new ScriptRunner(fake.runner);
    await runner.runAppleScript('on run argv\nreturn item 1 of argv\nend run', ["data"]);
    const call = fake.calls[0]!;
    expect(call.cmd).toBe("/usr/bin/osascript");
    expect(call.args[0]).toBe("-e");
    expect(call.args[1]).toBe('on run argv\nreturn item 1 of argv\nend run');
    expect(call.args[2]).toBe("data");
  });
});

describe("ScriptRunner — shell-laundering refusal (D-02)", () => {
  it("SHELL_LAUNDERING_PATTERNS has at least 5 entries and rejectShellLaundering is exported", () => {
    expect(SHELL_LAUNDERING_PATTERNS.length).toBeGreaterThanOrEqual(5);
    expect(typeof rejectShellLaundering).toBe("function");
  });

  const laundering: Array<[string, string]> = [
    ["do shell script", 'do shell script "rm -rf /"'],
    ["doShellScript", 'app.doShellScript("rm -rf /")'],
    ["ObjC.import", "ObjC.import('Foundation')"],
    ["$.NSTask", "$.NSTask.alloc().init()"],
    ["Application(\"Terminal\")", 'Application("Terminal").doScript("ls")'],
    // 15 CR-03: these two were EXECUTED live against the original five-pattern
    // denylist and both reached a real shell.
    ["AppleScript concatenation", 'run script ("do sh" & "ell script \\"echo pwned\\"")'],
    ["JXA computed member", 'const a=Application.currentApplication(); a["doShell"+"Script"]("echo pwned")'],
    // Additional laundering surfaces the original list did not cover.
    ["ObjC bracket import", 'ObjC["import"]("Foundation")'],
    ["$ bracket NSTask", '$["NSTask"].alloc.init'],
    ["Script Editor", 'Application("Script Editor").documents.push(x)'],
    ["Automator", 'Application("Automator").run()'],
    ["eval of assembled source", 'eval("do" + "ShellScript")'],
    ["Application name concatenation", 'Application("Term" + "inal").doScript("ls")'],
  ];

  for (const [label, script] of laundering) {
    it(`runJxa refuses a script containing: ${label} — calls.length === 0`, async () => {
      const fake = new FakeMacRunner();
      const runner = new ScriptRunner(fake.runner);
      const result = await runner.runJxa(script, []);
      expect(result.ok).toBe(false);
      expect(fake.calls.length).toBe(0);
    });

    it(`runAppleScript refuses a script containing: ${label} — calls.length === 0`, async () => {
      const fake = new FakeMacRunner();
      const runner = new ScriptRunner(fake.runner);
      const result = await runner.runAppleScript(script, []);
      expect(result.ok).toBe(false);
      expect(fake.calls.length).toBe(0);
    });
  }

  it("delaunderSource collapses the concatenation shapes that defeated the raw denylist", () => {
    expect(delaunderSource('("do sh" & "ell script \\"x\\"")')).toContain("do shell script");
    expect(delaunderSource('a["doShell"+"Script"]')).toContain("doShellScript");
  });

  it("the refusal message does NOT claim shell access is impossible — the gate is the control (CR-03)", () => {
    const message = rejectShellLaundering('do shell script "ls"');
    expect(message).toBeTruthy();
    expect(String(message)).not.toMatch(/shell access is refused/i);
    expect(String(message)).toMatch(/known shell-laundering pattern/i);
  });

  it("a clean script returns null — which means 'no known shape matched', not 'cannot reach a shell'", () => {
    expect(rejectShellLaundering("function run(argv) { return argv[0]; }")).toBeNull();
  });
});

describe("ScriptRunner — TCC degrade", () => {
  it("maps a timedOut result to automation-undecided-timeout", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "", stderr: "", exitCode: 1, timedOut: true };
    const runner = new ScriptRunner(fake.runner);
    const result = await runner.runJxa("function run(argv){return 1;}", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("automation-undecided-timeout");
  });

  it("maps a -25211 stderr to accessibility-denied", async () => {
    const fake = new FakeMacRunner();
    fake.result = {
      stdout: "",
      stderr: "osascript is not allowed assistive access. (-25211)",
      exitCode: 1,
      timedOut: false,
    };
    const runner = new ScriptRunner(fake.runner);
    const result = await runner.runJxa("function run(argv){return 1;}", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("accessibility-denied");
      expect(result.error).toContain("Accessibility");
    }
  });
});

// ── ShortcutsRunner ───────────────────────────────────────────────────────────

describe("ShortcutsRunner.list", () => {
  it("parses multi-line stdout into an array", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "Morning Routine\nEnable Focus\nMake Coffee\n", stderr: "", exitCode: 0, timedOut: false };
    const runner = new ShortcutsRunner(fake.runner);
    const result = await runner.list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.shortcuts).toEqual(["Morning Routine", "Enable Focus", "Make Coffee"]);
    }
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/shortcuts", args: ["list"] }]);
  });

  it("skips blank lines", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "One\n\n\nTwo\n", stderr: "", exitCode: 0, timedOut: false };
    const runner = new ShortcutsRunner(fake.runner);
    const result = await runner.list();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.shortcuts).toEqual(["One", "Two"]);
  });
});

describe("ShortcutsRunner.run", () => {
  it("invokes shortcuts run <name>", async () => {
    const fake = new FakeMacRunner();
    const runner = new ShortcutsRunner(fake.runner);
    const result = await runner.run("Make Coffee");
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual([{ cmd: "/usr/bin/shortcuts", args: ["run", "Make Coffee"] }]);
  });

  it("refuses an empty name without touching the runner", async () => {
    const fake = new FakeMacRunner();
    const runner = new ShortcutsRunner(fake.runner);
    const result = await runner.run("");
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("refuses a name starting with - without touching the runner", async () => {
    const fake = new FakeMacRunner();
    const runner = new ShortcutsRunner(fake.runner);
    const result = await runner.run("-i");
    expect(result.ok).toBe(false);
    expect(fake.calls.length).toBe(0);
  });

  it("maps an unknown-shortcut stderr to shortcut-not-found", async () => {
    const fake = new FakeMacRunner();
    fake.result = { stdout: "", stderr: "No shortcut named 'Bogus' was found.", exitCode: 1, timedOut: false };
    const runner = new ShortcutsRunner(fake.runner);
    const result = await runner.run("Bogus");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("shortcut-not-found");
  });
});
