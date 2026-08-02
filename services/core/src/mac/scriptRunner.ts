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
 * HONEST SCOPE OF `rejectShellLaundering` (15 CR-03 — read this before
 * relying on it): it is a best-effort DENYLIST over the script's source
 * text, not a security boundary. AppleScript and JXA are Turing-complete and
 * build identifiers and strings at runtime, so a determined script can still
 * reach a shell — `run script ("do sh" & "ell script ...")` and
 * `a["doShell"+"Script"](...)` were both executed live against the original
 * five-pattern list and both reached a real shell. The normalization below
 * catches those demonstrated laundering shapes and the list has been widened,
 * but no source-text check can bound the language.
 *
 * The control that actually holds is the APPROVAL GATE: `mac_run_script` is
 * `readOnly: false` and registers `sideEffects: "mac_action"`, which
 * DECISION_TABLE.mac_action resolves to `require_approval` unconditionally —
 * a human approves every script before it runs, and the tool description
 * says plainly that a script can ultimately reach a shell. Treat the
 * denylist as a speed bump that catches the obvious cases, never as a
 * guarantee, and never weaken the gate on the strength of it.
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
 * spawn — a match means zero calls ever reach the injected runner. Matched
 * against both the raw source and the delaundered form (see
 * `delaunderSource`). NOT exhaustive — see the CR-03 note in the header.
 */
export const SHELL_LAUNDERING_PATTERNS: RegExp[] = [
  /do\s+shell\s+script/i,
  /doShellScript/i,
  // `run script` evaluates assembled source text — the demonstrated
  // concatenation bypass rode exactly this.
  /\brun\s+script\b/i,
  // ObjC.import / ObjC["import"] / $.NSTask / $["NSTask"] — the ObjC bridge.
  /\bObjC\s*[.[]/,
  /\$\s*[.[]\s*["']?NS/,
  /\bNSTask\b/,
  /\bNSAppleScript\b/,
  // Apps whose whole purpose is running arbitrary code. Quotes are OPTIONAL
  // so the pattern also matches the delaundered form, where they are stripped.
  /\bApplication\(\s*["']?(Terminal|iTerm2?|Script Editor|Automator)["']?\s*\)/i,
  // Runtime source evaluation.
  /\beval\s*\(/,
  /\bFunction\s*\(/,
];

/**
 * Collapse the string-concatenation laundering shapes that defeated the raw
 * denylist, so `("do sh" & "ell script ...")` and `a["doShell"+"Script"]`
 * are matched by the same patterns as their literal forms. Joins adjacent
 * quoted fragments across `&` (AppleScript) and `+` (JXA), repeatedly, then
 * strips the remaining quotes so `["doShellScript"]` reads as an identifier.
 */
export function delaunderSource(script: string): string {
  let out = script;
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/(["'])\s*[&+]\s*(["'])/g, "");
    if (next === out) break;
    out = next;
  }
  return out.replace(/["']/g, "");
}

/**
 * Returns a human-readable description of the matched shell-laundering
 * pattern, or null if the script matched nothing. A null return means "no
 * known laundering shape was found", NOT "this script cannot reach a shell"
 * (CR-03) — the approval gate is what bounds that.
 */
export function rejectShellLaundering(script: string): string | null {
  const delaundered = delaunderSource(script);
  for (const pattern of SHELL_LAUNDERING_PATTERNS) {
    if (pattern.test(script) || pattern.test(delaundered)) {
      return `script matches a known shell-laundering pattern (${pattern.source}) and was rejected before any spawn (D-02)`;
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
