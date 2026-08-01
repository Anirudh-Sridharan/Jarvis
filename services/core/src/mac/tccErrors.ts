/**
 * Structured TCC-failure classification for every Mac-control native call.
 *
 * Maps a MacCommandResult's stderr/timedOut signal to a named, actionable
 * remediation — never let a raw error string reach the agent scratchpad
 * (degrade-never-crash convention, mirrors the web_search/web_extract
 * precedent in services/core/src/agent/tools/webExtractTool.ts).
 *
 * Classification precedence (live-verified on macOS 26.5 per
 * 15-RESEARCH.md): timedOut wins outright (an undecided Automation-consent
 * dialog hangs for well over two minutes with no human present, so our own
 * ~15s execFile timeout firing first is the most actionable signal we can
 * give); then automation-denied (-1743); then accessibility-denied
 * (-25211); then screen-recording-denied; then shortcut-not-found;
 * otherwise unknown.
 */

import type { MacCommandResult } from "./commandRunner.js";

export type TccFailureKind =
  | "automation-denied"
  | "automation-undecided-timeout"
  | "accessibility-denied"
  | "screen-recording-denied"
  | "shortcut-not-found"
  | "unknown";

/** Cap on stderr appended to a macFailure()'s error message — never let a
 * pathological/verbose stderr flood the agent scratchpad. */
const MAX_STDERR_CHARS = 500;

export function classifyTccFailure(
  stderr: string,
  timedOut: boolean,
): TccFailureKind {
  if (timedOut) return "automation-undecided-timeout";
  if (/-1743|Not authorized to send Apple events/i.test(stderr)) {
    return "automation-denied";
  }
  if (/-25211|not allowed assistive access/i.test(stderr)) {
    return "accessibility-denied";
  }
  if (/could not create image from display/i.test(stderr)) {
    return "screen-recording-denied";
  }
  if (/no shortcut(s)? (named|found)|couldn't find shortcut/i.test(stderr)) {
    return "shortcut-not-found";
  }
  return "unknown";
}

/**
 * One actionable remediation sentence per TccFailureKind. `target`, when
 * supplied (typically the app/shortcut name involved), is interpolated into
 * the sentence.
 */
export function tccRemediation(kind: TccFailureKind, target?: string): string {
  const app = target ? `"${target}"` : "the target app";
  switch (kind) {
    case "automation-undecided-timeout":
      return (
        `macOS is waiting on a one-time consent dialog for ${app} — run this ` +
        `action once with ${app} in the foreground so macOS can show its ` +
        `Automation prompt, or grant it manually under System Settings > ` +
        `Privacy & Security > Automation.`
      );
    case "automation-denied":
      return (
        `Automation permission for ${app} was denied — grant it under ` +
        `System Settings > Privacy & Security > Automation.`
      );
    case "accessibility-denied":
      return (
        `Accessibility permission is required for this action. Grant it ` +
        `under System Settings > Privacy & Security > Accessibility — the ` +
        `grant attaches to the terminal or IDE application that launched ` +
        `Jarvis, not to node or osascript. Run \`npm run mac-doctor\` to ` +
        `check which app needs the grant.`
      );
    case "screen-recording-denied":
      return (
        `Screen Recording permission is required for this action. Grant it ` +
        `under System Settings > Privacy & Security > Screen Recording — ` +
        `the grant attaches to the terminal or IDE application that ` +
        `launched Jarvis, not to node or osascript. Run \`npm run mac-doctor\` ` +
        `to check which app needs the grant.`
      );
    case "shortcut-not-found":
      return (
        `Shortcut ${app} was not found — use mac_list_shortcuts to see the ` +
        `available named Shortcuts.`
      );
    case "unknown":
    default:
      return `The command failed.`;
  }
}

/**
 * Compose classification + remediation into a structured, never-throwing
 * failure result. `error` is the remediation sentence followed by the
 * trimmed stderr, capped at MAX_STDERR_CHARS characters.
 */
export function macFailure(
  result: MacCommandResult,
  context: { command: string; target?: string },
): { ok: false; error: string; kind: TccFailureKind } {
  const kind = classifyTccFailure(result.stderr, result.timedOut);
  const remediation = tccRemediation(kind, context.target);
  const trimmedStderr = result.stderr.trim().slice(0, MAX_STDERR_CHARS);
  const error = trimmedStderr
    ? `${remediation} (${context.command} stderr: ${trimmedStderr})`
    : remediation;
  return { ok: false, error, kind };
}
