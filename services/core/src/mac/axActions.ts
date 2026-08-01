/**
 * axActions.ts — Tier 2 gated Accessibility UI actions (phase 15, plan
 * 15-04): click/type/key against refs produced by axSnapshot.ts.
 *
 * D-03 (logins are never automated by the model typing credentials): a
 * typing action is refused BEFORE any keystroke is synthesized whenever the
 * target element's role — or the process's separately-read
 * AXFocusedUIElement role — is secure or undeterminable. The refusal
 * decision is made in TypeScript on roles read by a first, inspect-only
 * script call; only a non-secure, determinable pair of roles earns a SECOND
 * script call that actually types. This two-call structure means the secret
 * text never reaches a spawn on the refusal path (test-asserted in
 * axActions.test.ts).
 *
 * D-08 (unknown fails safe): `isSecureRole` returns true for `null`,
 * `undefined`, and `""` — an undeterminable role is treated as secure.
 *
 * Every role read inside a script body tries `el.role()` first, falling back
 * to `el.attributes.byName("AXRole").value()`, returning an empty string if
 * both fail — this closes 15-RESEARCH's Assumption A1 without needing a live
 * spike, because an empty role is itself treated as secure.
 */

import { ScriptRunner } from "./scriptRunner.js";
import { parseAxRef } from "./axSnapshot.js";
import type { TccFailureKind } from "./tccErrors.js";

/** Roles that must never receive synthesized keystrokes (D-03). */
export const SECURE_FIELD_ROLES = ["AXSecureTextField", "AXSecureTextArea"];

/**
 * Case-insensitive check against SECURE_FIELD_ROLES. Returns TRUE for
 * null/undefined/empty — an undeterminable role fails CLOSED (D-08).
 */
export function isSecureRole(role: string | null | undefined): boolean {
  if (role === null || role === undefined || role === "") return true;
  return SECURE_FIELD_ROLES.some((r) => r.toLowerCase() === role.toLowerCase());
}

export type AxActionResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; kind: TccFailureKind; refused?: string };

const SECURE_FIELD_REFUSAL =
  "refusing to type into a secure field — Jarvis never enters credentials; use Keychain/passkey autofill instead";

/** Allowlisted key names -> System Events key codes. Anything outside this
 * set is refused pre-spawn. */
const ALLOWED_KEYS: Record<string, number> = {
  Enter: 36,
  Return: 36,
  Tab: 48,
  Escape: 53,
  Space: 49,
  Delete: 51,
  ArrowUp: 126,
  ArrowDown: 125,
  ArrowLeft: 123,
  ArrowRight: 124,
};

// ── Fixed JXA script bodies (never string-concatenated with untrusted data) ───

const READ_ROLE_HELPER = `
function readRole(el) {
  try { var r = el.role(); if (r) return r; } catch (e) {}
  try { var v = el.attributes.byName("AXRole").value(); if (v) return v; } catch (e) {}
  return "";
}
`;

/** argv: [app, indexPath, expectedRole]. Walks to the element, compares the
 * live role to expectedRole; on match performs AXPress and returns
 * { success:true }, on mismatch returns { stale:true, actualRole }. */
const AX_CLICK_SCRIPT = `
${READ_ROLE_HELPER}
function run(argv) {
  const appName = argv[0];
  const indexPath = argv[1].split(".").map(Number);
  const expectedRole = argv[2];
  const se = Application("System Events");
  const proc = se.processes.byName(appName);
  let el = proc.windows[0];
  for (let i = 0; i < indexPath.length; i++) {
    el = el.uiElements()[indexPath[i]];
  }
  const actualRole = readRole(el);
  if (actualRole !== expectedRole) {
    return JSON.stringify({ stale: true, actualRole: actualRole });
  }
  el.actions.byName("AXPress").perform();
  return JSON.stringify({ success: true });
}
`;

/** argv: [x, y]. Clicks at a screen coordinate — the entry point Tier 3
 * (plan 15-05) uses for vision-grounded clicks. */
const AX_CLICK_AT_SCRIPT = `
function run(argv) {
  const x = parseInt(argv[0], 10);
  const y = parseInt(argv[1], 10);
  const se = Application("System Events");
  se.click({ x: x, y: y });
  return JSON.stringify({ success: true });
}
`;

/** argv: [app, indexPath]. Inspect-only: focuses the element, reads its role
 * AND separately the process's AXFocusedUIElement role. Types NOTHING. */
const AX_TYPE_INSPECT_SCRIPT = `
${READ_ROLE_HELPER}
function run(argv) {
  const appName = argv[0];
  const indexPath = argv[1].split(".").map(Number);
  const se = Application("System Events");
  const proc = se.processes.byName(appName);
  let el = proc.windows[0];
  for (let i = 0; i < indexPath.length; i++) {
    el = el.uiElements()[indexPath[i]];
  }
  try {
    el.actions.byName("AXFocus").perform();
  } catch (e) {}
  const elementRole = readRole(el);
  let focusedRole = "";
  try {
    const focused = proc.attributes.byName("AXFocusedUIElement").value();
    focusedRole = readRole(focused);
  } catch (e) {}
  return JSON.stringify({ elementRole: elementRole, focusedRole: focusedRole });
}
`;

/** argv: [app, indexPath, text, submit01]. Only reached after the refusal
 * decision has cleared — keystrokes text and, if submit, a Return. */
const AX_TYPE_KEYSTROKE_SCRIPT = `
function run(argv) {
  const appName = argv[0];
  const indexPath = argv[1].split(".").map(Number);
  const text = argv[2];
  const submit = argv[3] === "1";
  const se = Application("System Events");
  const proc = se.processes.byName(appName);
  let el = proc.windows[0];
  for (let i = 0; i < indexPath.length; i++) {
    el = el.uiElements()[indexPath[i]];
  }
  try {
    el.actions.byName("AXFocus").perform();
  } catch (e) {}
  se.keystroke(text);
  if (submit) se.keyCode(36);
  return JSON.stringify({ success: true });
}
`;

/** argv: []. Inspect-only: reads the role of whatever process/element
 * currently has focus (no ref addressing — vision-grounded click leaves
 * focus somewhere the model did not address by ref). */
const AX_TYPE_AT_FOCUS_INSPECT_SCRIPT = `
${READ_ROLE_HELPER}
function run(argv) {
  const se = Application("System Events");
  const matches = se.processes.whose({ frontmost: true });
  const proc = matches[0];
  let focusedRole = "";
  try {
    const focused = proc.attributes.byName("AXFocusedUIElement").value();
    focusedRole = readRole(focused);
  } catch (e) {}
  return JSON.stringify({ focusedRole: focusedRole });
}
`;

/** argv: [text, submit01]. Only reached after the refusal decision has
 * cleared. */
const AX_TYPE_AT_FOCUS_KEYSTROKE_SCRIPT = `
function run(argv) {
  const text = argv[0];
  const submit = argv[1] === "1";
  const se = Application("System Events");
  se.keystroke(text);
  if (submit) se.keyCode(36);
  return JSON.stringify({ success: true });
}
`;

/** argv: [keyCode]. Only reached for allowlisted keys. */
const AX_PRESS_KEY_SCRIPT = `
function run(argv) {
  const keyCode = parseInt(argv[0], 10);
  const se = Application("System Events");
  se.keyCode(keyCode);
  return JSON.stringify({ success: true });
}
`;

export class AxActionRunner {
  constructor(private readonly script: ScriptRunner = new ScriptRunner()) {}

  /** Click the element at `ref`. Refuses pre-spawn on a malformed ref;
   * refuses (after exactly one call) on a stale (mismatched live role) ref. */
  async click(ref: string): Promise<AxActionResult> {
    const parsed = parseAxRef(ref);
    if (!parsed) {
      return { ok: false, error: "malformed ref — re-run mac_ui_snapshot", kind: "unknown" };
    }

    const result = await this.script.runJxa(AX_CLICK_SCRIPT, [
      parsed.app,
      parsed.indexPath.join("."),
      parsed.role,
    ]);
    if (!result.ok) return result;

    let parsedOut: { stale?: boolean; actualRole?: string };
    try {
      parsedOut = JSON.parse(result.stdout) as { stale?: boolean; actualRole?: string };
    } catch {
      return { ok: false, error: "failed to parse click result", kind: "unknown" };
    }

    if (parsedOut.stale) {
      return {
        ok: false,
        error: `stale ref (element is now ${parsedOut.actualRole}) — re-run mac_ui_snapshot`,
        kind: "unknown",
      };
    }

    return { ok: true, clicked: ref };
  }

  /** Click at a screen coordinate — the Tier 3 (plan 15-05) entry point.
   * Refuses non-finite or negative integer coordinates before spawning. */
  async clickAt(point: { x: number; y: number }): Promise<AxActionResult> {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isInteger(point.x) ||
      !Number.isInteger(point.y) ||
      point.x < 0 ||
      point.y < 0
    ) {
      return { ok: false, error: "clickAt requires non-negative integer coordinates", kind: "unknown" };
    }

    const result = await this.script.runJxa(AX_CLICK_AT_SCRIPT, [String(point.x), String(point.y)]);
    if (!result.ok) return result;
    return { ok: true, clicked: `${point.x},${point.y}` };
  }

  /**
   * Type `text` into the element at `ref`. Two-call structure: an
   * inspect-only first call reads both the element's role and the process's
   * AXFocusedUIElement role; if either is secure (or undeterminable), a
   * refusal is returned with NO second call and the secret text never
   * reaches a spawn. Only when both roles are non-secure does a second call
   * keystroke the text (and, if `submit`, a Return).
   */
  async type(ref: string, text: string, submit?: boolean): Promise<AxActionResult> {
    const parsed = parseAxRef(ref);
    if (!parsed) {
      return { ok: false, error: "malformed ref — re-run mac_ui_snapshot", kind: "unknown" };
    }

    const inspect = await this.script.runJxa(AX_TYPE_INSPECT_SCRIPT, [parsed.app, parsed.indexPath.join(".")]);
    if (!inspect.ok) return inspect;

    let roles: { elementRole?: string; focusedRole?: string };
    try {
      roles = JSON.parse(inspect.stdout) as { elementRole?: string; focusedRole?: string };
    } catch {
      return { ok: false, error: "failed to parse type inspection result", kind: "unknown" };
    }

    if (isSecureRole(roles.elementRole) || isSecureRole(roles.focusedRole)) {
      return { ok: false, error: SECURE_FIELD_REFUSAL, kind: "unknown", refused: "secure-field" };
    }

    const keystroke = await this.script.runJxa(AX_TYPE_KEYSTROKE_SCRIPT, [
      parsed.app,
      parsed.indexPath.join("."),
      text,
      submit ? "1" : "0",
    ]);
    if (!keystroke.ok) return keystroke;
    return { ok: true, typed: ref };
  }

  /**
   * Type `text` into whatever currently has focus (no ref addressing) — the
   * variant Tier 3 (plan 15-05) uses since a vision-grounded click leaves
   * focus somewhere the model did not address by ref. Identical two-call,
   * refuse-before-second-call structure as `type`.
   */
  async typeAtFocus(text: string, submit?: boolean): Promise<AxActionResult> {
    const inspect = await this.script.runJxa(AX_TYPE_AT_FOCUS_INSPECT_SCRIPT, []);
    if (!inspect.ok) return inspect;

    let roles: { focusedRole?: string };
    try {
      roles = JSON.parse(inspect.stdout) as { focusedRole?: string };
    } catch {
      return { ok: false, error: "failed to parse focus inspection result", kind: "unknown" };
    }

    if (isSecureRole(roles.focusedRole)) {
      return { ok: false, error: SECURE_FIELD_REFUSAL, kind: "unknown", refused: "secure-field" };
    }

    const keystroke = await this.script.runJxa(AX_TYPE_AT_FOCUS_KEYSTROKE_SCRIPT, [text, submit ? "1" : "0"]);
    if (!keystroke.ok) return keystroke;
    return { ok: true, typed: "focus" };
  }

  /** Press an allowlisted key. Any key outside ALLOWED_KEYS is refused
   * pre-spawn. */
  async pressKey(key: string): Promise<AxActionResult> {
    const keyCode = ALLOWED_KEYS[key];
    if (keyCode === undefined) {
      return { ok: false, error: `key "${key}" is not in the allowed key list`, kind: "unknown" };
    }

    const result = await this.script.runJxa(AX_PRESS_KEY_SCRIPT, [String(keyCode)]);
    if (!result.ok) return result;
    return { ok: true, pressed: key };
  }
}
