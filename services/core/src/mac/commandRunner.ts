/**
 * MacCommandRunner — the single process boundary for every Mac-control
 * native call (D-07). Adapts services/core/src/integrations/keychainTokenStore.ts's
 * CommandRunner pattern with three deliberate divergences, recorded here:
 *
 * 1. Exported names are `Mac`-prefixed so a module importing both this seam
 *    and keychainTokenStore.ts's unrelated CommandRunner cannot confuse them.
 * 2. An explicit `timeout` is always passed to `execFile` — an undecided
 *    Automation-consent dialog otherwise hangs the caller for well over two
 *    minutes with no human present to click "Allow" (verified live,
 *    15-RESEARCH.md Common Pitfalls Pitfall 2 — Contacts.app hung ~2min then
 *    failed with AppleEvent timed out (-1712)).
 * 3. The result carries `timedOut` because the TCC classifier (tccErrors.ts)
 *    must distinguish a self-imposed timeout from a real non-zero exit.
 */

import { execFile } from "node:child_process";

export interface MacCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface MacCommandOptions {
  timeoutMs?: number;
}

export type MacCommandRunner = (
  cmd: string,
  args: string[],
  opts?: MacCommandOptions,
) => Promise<MacCommandResult>;

/** Default per-call timeout (ms) — well under the ~2 minute undecided-Automation hang. */
export const MAC_COMMAND_TIMEOUT_MS = 15_000;

/** Hard ceiling any caller-supplied (or default) timeoutMs is clamped to. */
export const MAC_COMMAND_TIMEOUT_MAX_MS = 60_000;

/** Floor a caller-supplied timeoutMs is raised to — a near-zero timeout would
 * make every call spuriously report timedOut before the process could ever
 * complete. */
const MAC_COMMAND_TIMEOUT_MIN_MS = 1_000;

/** SIGKILL (not the execFile default SIGTERM) so a hung AppleEvent call
 * cannot ignore the timeout signal. */
const KILL_SIGNAL = "SIGKILL";

function clampTimeout(
  timeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  const requested = timeoutMs ?? defaultTimeoutMs;
  return Math.min(
    Math.max(requested, MAC_COMMAND_TIMEOUT_MIN_MS),
    MAC_COMMAND_TIMEOUT_MAX_MS,
  );
}

/**
 * Build a MacCommandRunner backed by node:child_process's execFile. Never
 * spawns a shell (no `exec`, no `spawn({shell:true})`, no `/bin/sh`) —
 * callers always pass an argv array, so shell metacharacters in any argument
 * are inert data, never interpreted (D-02; verified live via
 * 15-RESEARCH.md's JXA `run(argv)` pattern).
 *
 * Never throws: always resolves with the captured stdout/stderr, an
 * exitCode derived from the child's own numeric exit code (or 1 when the
 * error carries no numeric code), and timedOut set true only when THIS
 * call's own timeout fired — distinguishing a self-imposed timeout from a
 * real non-zero exit (the distinction tccErrors.ts's classifyTccFailure
 * depends on).
 */
export function makeExecFileMacRunner(
  defaultTimeoutMs: number = MAC_COMMAND_TIMEOUT_MS,
): MacCommandRunner {
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      const timeout = clampTimeout(opts?.timeoutMs, defaultTimeoutMs);
      execFile(
        cmd,
        args,
        {
          encoding: "utf8",
          timeout,
          killSignal: KILL_SIGNAL,
          maxBuffer: 8 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ stdout, stderr, exitCode: 0, timedOut: false });
            return;
          }
          const errWithMeta = err as NodeJS.ErrnoException & {
            code?: unknown;
            killed?: boolean;
            signal?: string | null;
          };
          const timedOut =
            errWithMeta.killed === true || errWithMeta.signal === KILL_SIGNAL;
          const exitCode =
            typeof errWithMeta.code === "number" ? errWithMeta.code : 1;
          resolve({ stdout, stderr, exitCode, timedOut });
        },
      );
    });
}

/** Default live runner — execFile with MAC_COMMAND_TIMEOUT_MS as the default
 * per-call timeout. */
export const execFileMacRunner: MacCommandRunner = makeExecFileMacRunner();
