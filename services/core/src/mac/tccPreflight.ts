/**
 * tccPreflight.ts — closes D-09/15-SC6: makes the live TCC-grant story
 * executable rather than folklore. `checkMacGrants` runs four independent,
 * SHORT-timeout (5000ms) probes — one per TCC boundary this phase's tools
 * depend on — and reports each grant's real status plus a named,
 * actionable remediation. `describeResponsibleProcess` walks the LIVE
 * process ancestry so the CLI can name the actual application bundle macOS
 * will attribute a grant to, rather than assuming "node" or "Terminal"
 * (15-RESEARCH.md Pitfall 1 — this machine's own ancestry traced live as
 * `zsh -> claude -> zsh -> Code Helper -> Visual Studio Code 2.app`).
 *
 * Every probe passes `timeoutMs: 5000` — far below the ~2-minute undecided-
 * Automation hang (15-RESEARCH.md Pitfall 2, tccErrors.ts) — so a preflight
 * itself can never stall waiting on a consent dialog; a timeout is reported
 * as `automation-undecided-timeout`, itself useful information.
 *
 * Probes run SEQUENTIALLY, never `Promise.all` — a consent dialog surfacing
 * for one probe must never be confused with a genuine failure of another
 * (each probe's own dialog, if any, is independent and modal).
 *
 * `describeResponsibleProcess`'s inference is best-effort: the only
 * authoritative confirmation of which app received a grant is the
 * application name shown in the actual consent dialog itself. Both the CLI
 * output and the 15-06 runbook state this explicitly (T-15-35).
 */

import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MacCommandOptions, MacCommandResult, MacCommandRunner } from "./commandRunner.js";
import { execFileMacRunner } from "./commandRunner.js";
import { classifyTccFailure, tccRemediation, type TccFailureKind } from "./tccErrors.js";

const OSASCRIPT_BIN = "/usr/bin/osascript";
const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const SHORTCUTS_BIN = "/usr/bin/shortcuts";
const PS_BIN = "/bin/ps";

/** Preflight probes must never sit through the ~2min undecided-Automation
 * hang (15-RESEARCH.md Pitfall 2) — far shorter than the tools' own 15s
 * MAC_COMMAND_TIMEOUT_MS default, since a doctor command must return fast. */
const PREFLIGHT_TIMEOUT_MS = 5000;

/** Hard cap on ancestry-walk levels — terminates even a cyclic/repeating
 * ppid chain that never reaches pid 1. */
const MAX_ANCESTRY_LEVELS = 12;

export type MacGrantName = "automation-system-events" | "accessibility" | "screen-recording" | "shortcuts";

export interface MacGrantStatus {
  grant: MacGrantName;
  tier: 1 | 2 | 3;
  granted: boolean;
  kind: TccFailureKind | null;
  detail: string;
  remediation: string | null;
}

export interface ProcessAncestryEntry {
  pid: number;
  command: string;
}

export interface ResponsibleProcessInfo {
  chain: ProcessAncestryEntry[];
  likelyResponsibleApp: string | null;
  note: string;
}

export interface MacGrantReport {
  grants: MacGrantStatus[];
  responsibleProcess: ResponsibleProcessInfo;
  allGranted: boolean;
}

/** Minimal injectable filesystem seam for the screen-recording probe's temp
 * capture path — mirrors screenshotRunner.ts's ScreenshotFs so tests stay
 * hermetic (no real disk I/O, no real screen capture). */
export interface PreflightFs {
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
}

const liveFs: PreflightFs = {
  mkdtemp: (prefix) => fsMkdtemp(prefix),
  rm: (p, opts) => fsRm(p, opts),
};

const RESPONSIBLE_PROCESS_NOTE =
  'macOS attributes TCC grants via the "responsible process" mechanism, which for a ' +
  "terminal- or IDE-launched process very likely walks up to the enclosing GUI " +
  "application bundle — NOT to node or osascript directly. This is a best-effort " +
  "inference from the live process ancestry below; the authoritative confirmation is " +
  "always the application name shown in the actual System Settings consent dialog.";

// ── Fixed JXA script bodies (never string-concatenated with untrusted data) ───
// Neither script accepts argv — both are parameterless probes.

/** Tier 1 probe: process-name enumeration only needs Automation for System
 * Events — live-verified (15-RESEARCH.md) to succeed without Accessibility. */
const SYSTEM_EVENTS_PROCESSES_SCRIPT = `
function run(argv) {
  return String(Application("System Events").processes.length);
}
`;

/** Tier 2 probe: touching .windows on the frontmost process is the exact
 * call live-verified to fail with -25211 when Accessibility is ungranted. */
const FRONTMOST_WINDOWS_SCRIPT = `
function run(argv) {
  const se = Application("System Events");
  const matches = se.processes.whose({ frontmost: true });
  const proc = matches[0];
  return String(proc.windows[0].name());
}
`;

async function probeAutomationSystemEvents(run: MacCommandRunner): Promise<MacCommandResult> {
  return run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", SYSTEM_EVENTS_PROCESSES_SCRIPT], {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
}

async function probeAccessibility(run: MacCommandRunner): Promise<MacCommandResult> {
  return run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", FRONTMOST_WINDOWS_SCRIPT], {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
}

/** Tier 3 probe: captures into a mkdtemp directory removed in a `finally` on
 * both success and failure — the image is never read, encoded or
 * transmitted, only the exit code/stderr are inspected (T-15-37). */
async function probeScreenRecording(run: MacCommandRunner, fs: PreflightFs): Promise<MacCommandResult> {
  let tmpDir: string | undefined;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-mac-doctor-"));
    const tmpPath = path.join(tmpDir, "probe.png");
    return await run(SCREENCAPTURE_BIN, ["-x", tmpPath], { timeoutMs: PREFLIGHT_TIMEOUT_MS });
  } finally {
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Swallow cleanup errors — never let temp-dir removal mask the probe result.
      }
    }
  }
}

async function probeShortcuts(run: MacCommandRunner): Promise<MacCommandResult> {
  return run(SHORTCUTS_BIN, ["list"], { timeoutMs: PREFLIGHT_TIMEOUT_MS });
}

function toGrantStatus(grant: MacGrantName, tier: 1 | 2 | 3, result: MacCommandResult): MacGrantStatus {
  if (result.exitCode === 0 && !result.timedOut) {
    return { grant, tier, granted: true, kind: null, detail: "granted", remediation: null };
  }
  const kind = classifyTccFailure(result.stderr, result.timedOut);
  const remediation = tccRemediation(kind);
  const detail = result.timedOut
    ? "timed out waiting for a response (undecided consent dialog?)"
    : result.stderr.trim() || `exited with code ${result.exitCode}`;
  return { grant, tier, granted: false, kind, detail, remediation };
}

/**
 * Run all four TCC-grant probes SEQUENTIALLY (never `Promise.all`) so a
 * consent dialog surfacing for one probe is never confused with a failure
 * of another, and so the fake runner's call log records a deterministic,
 * assertable order. Never throws — every probe degrades through
 * `classifyTccFailure`/`tccRemediation`, exactly like the tools themselves.
 */
export async function checkMacGrants(
  run: MacCommandRunner = execFileMacRunner,
  fs: PreflightFs = liveFs,
): Promise<MacGrantReport> {
  const grants: MacGrantStatus[] = [];

  grants.push(toGrantStatus("automation-system-events", 1, await probeAutomationSystemEvents(run)));
  grants.push(toGrantStatus("accessibility", 2, await probeAccessibility(run)));
  grants.push(toGrantStatus("screen-recording", 3, await probeScreenRecording(run, fs)));
  grants.push(toGrantStatus("shortcuts", 1, await probeShortcuts(run)));

  const responsibleProcess = await describeResponsibleProcess(run);

  return {
    grants,
    responsibleProcess,
    allGranted: grants.every((g) => g.granted),
  };
}

/** Parses one line of `ps -o ppid=,comm=` output into { ppid, command }.
 * Returns null for any unreadable/malformed shape — the caller must treat
 * that as a walk-terminating condition, never spawn further. */
function parsePsLine(stdout: string): { ppid: number; command: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)\s+(.+)$/s);
  if (!match) return null;
  const ppid = Number(match[1]);
  const command = match[2]!.trim();
  if (!Number.isFinite(ppid) || ppid <= 0 || !command) return null;
  return { ppid, command };
}

/** The first ancestor whose command path contains a `.app/` bundle segment,
 * reported as the bundle name. Walking from self upward and taking the
 * LEFTMOST `.app/` match within a matched entry's own command string
 * correctly picks the outer/enclosing bundle even for a nested helper
 * process path (e.g. ".../Visual Studio Code 2.app/Contents/Frameworks/
 * Code Helper.app/..." resolves to "Visual Studio Code 2.app", not the
 * nested "Code Helper.app", since the outer segment appears first in the
 * path string). */
function findLikelyResponsibleApp(chain: ProcessAncestryEntry[]): string | null {
  for (const entry of chain) {
    const match = entry.command.match(/\/([^/]+\.app)\//);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Walks the live process ancestry from `process.pid` upward via `/bin/ps`,
 * one call per level, capped at `MAX_ANCESTRY_LEVELS`, stopping at pid 1 or
 * an unreadable entry (or a repeated pid — a cyclic/malformed ancestry must
 * never spin this walk). Never throws — a `ps` failure simply ends the walk
 * with whatever ancestry was already collected.
 */
export async function describeResponsibleProcess(
  run: MacCommandRunner = execFileMacRunner,
): Promise<ResponsibleProcessInfo> {
  const chain: ProcessAncestryEntry[] = [];
  const seen = new Set<number>();
  let pid = process.pid;

  for (let level = 0; level < MAX_ANCESTRY_LEVELS; level++) {
    if (pid === 1) break;
    if (seen.has(pid)) break;
    seen.add(pid);

    const opts: MacCommandOptions = { timeoutMs: PREFLIGHT_TIMEOUT_MS };
    const result = await run(PS_BIN, ["-o", "ppid=,comm=", "-p", String(pid)], opts);
    if (result.exitCode !== 0 || result.timedOut) break;

    const parsed = parsePsLine(result.stdout);
    if (!parsed) break;

    chain.push({ pid, command: parsed.command });
    pid = parsed.ppid;
  }

  return {
    chain,
    likelyResponsibleApp: findLikelyResponsibleApp(chain),
    note: RESPONSIBLE_PROCESS_NOTE,
  };
}
