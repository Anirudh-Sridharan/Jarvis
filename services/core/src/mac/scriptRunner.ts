/**
 * ScriptRunner — Tier 1 native scripting capability: invokes `/usr/bin/osascript`
 * against an app's own scripting dictionary (AppleScript or JXA/JavaScript).
 *
 * D-02 (never an ungated shell escape hatch): the fixed script body is ALWAYS
 * the single `-e` argv element; the caller's variable data is ALWAYS separate
 * trailing argv elements, read inside the script via JXA's `run(argv)` handler
 * — never template data into the script body (verified live,
 * 15-RESEARCH.md Code Examples: a shell-metacharacter-laden string arrives as
 * literal data, never interpreted, because `execFile` never invokes a shell
 * and JXA's `run(argv)` receives argv as plain strings, not source text).
 *
 * `rejectShellLaundering` refuses any script that tries to reach a shell
 * (`do shell script`, `doShellScript`, `ObjC.import`, `$.NSTask`,
 * `Application("Terminal")`) BEFORE any spawn — there is no ungated escape
 * hatch from the scripting-dictionary sandbox to a real shell.
 */

import type { MacCommandRunner } from "./commandRunner.js";
import { execFileMacRunner } from "./commandRunner.js";
import { macFailure, type TccFailureKind } from "./tccErrors.js";

const OSASCRIPT_BIN = "/usr/bin/osascript";

/** Cap on stdout returned from a script — mirrors browserTools.ts's capText. */
const SCRIPT_STDOUT_CAP = 16_000;

/**
 * Patterns that indicate a script is trying to reach a shell or another
 * escape hatch out of the scripting-dictionary sandbox. Checked BEFORE any
 * spawn — a match means zero calls ever reach the injected runner.
 */
export const SHELL_LAUNDERING_PATTERNS: RegExp[] = [
  /do\s+shell\s+script/i,
  /doShellScript/,
  /ObjC\.import/,
  /\$\.NSTask/,
  /\bApplication\(["']Terminal["']\)/,
];

/**
 * Returns a human-readable description of the matched shell-laundering
 * pattern, or null if the script is clean.
 */
export function rejectShellLaundering(script: string): string | null {
  for (const pattern of SHELL_LAUNDERING_PATTERNS) {
    if (pattern.test(script)) {
      return `script matches disallowed shell-laundering pattern (${pattern.source}) — shell access is refused (D-02)`;
    }
  }
  return null;
}

export type ScriptResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; kind: TccFailureKind };

function capText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SCRIPT_STDOUT_CAP) return trimmed;
  return `${trimmed.slice(0, SCRIPT_STDOUT_CAP)}\n[truncated ${trimmed.length - SCRIPT_STDOUT_CAP} chars]`;
}

export class ScriptRunner {
  constructor(private readonly run: MacCommandRunner = execFileMacRunner) {}

  /** Run a JXA (`-l JavaScript`) script body with variable data as trailing argv. */
  async runJxa(
    scriptBody: string,
    argv: string[],
    opts?: { timeoutMs?: number },
  ): Promise<ScriptResult> {
    const refusal = rejectShellLaundering(scriptBody);
    if (refusal) return { ok: false, error: refusal, kind: "unknown" };

    const result = await this.run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", scriptBody, ...argv], opts);
    if (result.exitCode !== 0 || result.timedOut) {
      return macFailure(result, { command: "osascript -l JavaScript" });
    }
    return { ok: true, stdout: capText(result.stdout) };
  }

  /** Run an AppleScript script body with variable data as trailing argv. */
  async runAppleScript(
    scriptBody: string,
    argv: string[],
    opts?: { timeoutMs?: number },
  ): Promise<ScriptResult> {
    const refusal = rejectShellLaundering(scriptBody);
    if (refusal) return { ok: false, error: refusal, kind: "unknown" };

    const result = await this.run(OSASCRIPT_BIN, ["-e", scriptBody, ...argv], opts);
    if (result.exitCode !== 0 || result.timedOut) {
      return macFailure(result, { command: "osascript" });
    }
    return { ok: true, stdout: capText(result.stdout) };
  }
}
