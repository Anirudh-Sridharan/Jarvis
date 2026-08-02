/**
 * ShortcutsRunner — Tier 1 native Shortcuts capability: `/usr/bin/shortcuts`
 * wraps the Shortcuts app's CLI (`list`, `run`).
 *
 * Pitfall 4 (15-RESEARCH.md): the `shortcuts` CLI has no introspection/export
 * subcommand — a named Shortcut's internal steps cannot be read before it
 * runs. This runner does not attempt to work around that; the black-box
 * nature is surfaced explicitly in the `mac_run_shortcut` tool's description
 * (T-15-11) so the human approver sees it before approving.
 *
 * Note: the constructor field is named `runner` (not `run`, unlike
 * OpenRunner/ScriptRunner) to avoid colliding with this class's own public
 * `run(name)` method — `private readonly run: MacCommandRunner` would shadow
 * a same-named instance method, which TypeScript rejects as a duplicate
 * identifier.
 */

import type { MacCommandRunner } from "./commandRunner.js";
import { execFileMacRunner } from "./commandRunner.js";
import { macFailure, type TccFailureKind } from "./tccErrors.js";

const SHORTCUTS_BIN = "/usr/bin/shortcuts";

export type ShortcutsListResult =
  | { ok: true; shortcuts: string[] }
  | { ok: false; error: string; kind: TccFailureKind };

export type ShortcutsRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; kind: TccFailureKind };

export class ShortcutsRunner {
  constructor(private readonly runner: MacCommandRunner = execFileMacRunner) {}

  /** List available named Shortcuts, one per non-empty stdout line. */
  async list(): Promise<ShortcutsListResult> {
    const result = await this.runner(SHORTCUTS_BIN, ["list"]);
    if (result.exitCode !== 0 || result.timedOut) {
      return macFailure(result, { command: "shortcuts list" });
    }
    const shortcuts = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, shortcuts };
  }

  /** Run a named Shortcut. `name` is rejected when empty or option-injection-shaped. */
  async run(name: string): Promise<ShortcutsRunResult> {
    if (!name || name.length === 0) {
      return { ok: false, error: "shortcut name must not be empty", kind: "unknown" };
    }
    if (name.startsWith("-")) {
      return {
        ok: false,
        error: "shortcut name must not begin with \"-\" (option injection guard)",
        kind: "unknown",
      };
    }

    const result = await this.runner(SHORTCUTS_BIN, ["run", name]);
    if (result.exitCode !== 0 || result.timedOut) {
      return macFailure(result, { command: "shortcuts run", target: name });
    }
    return { ok: true, stdout: result.stdout.trim() };
  }
}
