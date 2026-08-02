/**
 * axActions.ts — Tier 2 gated Accessibility UI actions (phase 15, plan
 * 15-04): click/type/key against refs produced by axSnapshot.ts.
 *
 * D-03 (logins are never automated by the model typing credentials): a
 * typing action is refused BEFORE any keystroke is synthesized whenever the
 * target element — or the process's separately-read AXFocusedUIElement —
 * looks secure or undeterminable. The refusal decision is made in TypeScript
 * on the role AND SUBROLE read by a first, inspect-only script call; only a
 * non-secure, determinable pair earns a SECOND script call that actually
 * types. This two-call structure means the secret text never reaches a spawn
 * on the refusal path (test-asserted in axActions.test.ts).
 *
 * 15 CR-01 — the SUBROLE is the load-bearing attribute. macOS reports a real
 * password field (NSSecureTextField, `<input type=password>`) as
 * role `AXTextField` with subrole `AXSecureTextField`; there is no
 * `AXSecureTextField` ROLE and no `AXSecureTextArea` constant at all
 * (AppKit NSAccessibilityConstants.h / HIServices AXRoleConstants.h). A
 * role-only guard therefore never fires on a real password field. The role
 * is still checked defensively in case an app reports the secure marker
 * there.
 *
 * D-08 (unknown fails safe): `isSecureTarget` returns true for a
 * null/undefined/empty ROLE, and for a text-entry role whose SUBROLE could
 * not be read at all. It deliberately does NOT refuse when the element
 * definitively reports no subrole (axSnapshot's SUBROLE_NONE sentinel) —
 * that is every ordinary text field, and conflating "absent" with
 * "unreadable" would refuse all normal typing.
 *
 * 15 WR-03 (TOCTOU) — the inspect call and the keystroke call are separate
 * osascript processes, so focus can move between them. The keystroke scripts
 * therefore RE-READ role+subrole immediately before synthesizing anything and
 * abort with a `refused` sentinel if the observation no longer matches the
 * one the refusal decision was made against.
 */

import { ScriptRunner } from "./scriptRunner.js";
import { parseAxRef, AX_ROLE_HELPER_SCRIPT } from "./axSnapshot.js";
import type { TccFailureKind } from "./tccErrors.js";

/** Subroles that mark a credential field — the real macOS shape (D-03). */
export const SECURE_FIELD_SUBROLES = ["AXSecureTextField"];

/** Defensive: treat the secure marker as fatal if an app ever reports it as
 * a ROLE. macOS itself does not — see the CR-01 note in the header. */
export const SECURE_FIELD_ROLES = ["AXSecureTextField"];

/** Roles that accept typed text. For these, an UNREADABLE subrole fails
 * closed (it might be a secure field); a definitively-absent one does not. */
export const TEXT_ENTRY_ROLES = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];

function matchesAny(list: string[], value: string): boolean {
  return list.some((entry) => entry.toLowerCase() === value.toLowerCase());
}

/**
 * TRUE when the target may be a secure (credential) field and must never
 * receive synthesized keystrokes. Fails CLOSED (D-08) on an undeterminable
 * role, and on a text-entry role whose subrole could not be read.
 *
 * `subrole` carries three distinguishable states, produced by
 * axSnapshot.ts's shared readSubrole() helper:
 *   "AXSecureTextField"  -> secure, refuse
 *   SUBROLE_NONE         -> the element definitively has no subrole
 *   "" / null / undefined-> the subrole could not be READ -> fail closed
 */
export function isSecureTarget(
  role: string | null | undefined,
  subrole: string | null | undefined,
): boolean {
  if (role === null || role === undefined || role === "") return true;
  const sub = subrole ?? "";
  if (matchesAny(SECURE_FIELD_SUBROLES, sub)) return true;
  if (matchesAny(SECURE_FIELD_ROLES, role)) return true;
  if (matchesAny(TEXT_ENTRY_ROLES, role) && sub === "") return true;
  return false;
}

export type AxActionResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; kind: TccFailureKind; refused?: string };

const SECURE_FIELD_REFUSAL =
  "refusing to type into a secure field — Jarvis never enters credentials; use Keychain/passkey autofill instead";

const FOCUS_CHANGED_REFUSAL =
  "refusing to type — the target changed between the safety check and the keystroke " +
  "(a dialog or another app may have taken focus); nothing was typed. Re-run mac_ui_snapshot " +
  "and try again";

/** Allowlisted key names -> System Events key codes. Anything outside this
 * set is refused pre-spawn. A Map (not an object literal) so LLM-supplied
 * keys cannot reach through the prototype chain: `constructor`, `toString`,
 * `valueOf` and `hasOwnProperty` are all non-undefined on an object literal
 * and previously passed the guard, producing a spawn for a key the module
 * documented as refused (15 WR-05). */
const ALLOWED_KEYS = new Map<string, number>([
  ["Enter", 36],
  ["Return", 36],
  ["Tab", 48],
  ["Escape", 53],
  ["Space", 49],
  ["Delete", 51],
  ["ArrowUp", 126],
  ["ArrowDown", 125],
  ["ArrowLeft", 123],
  ["ArrowRight", 124],
]);

// ── Fixed JXA script bodies (never string-concatenated with untrusted data) ───

/**
 * In-script mirror of `isSecureTarget`, prepended to the keystroke scripts so
 * the D-03 decision is re-made in the SAME process that synthesizes the
 * keystroke (15 WR-03 — the inspect call is a separate osascript process and
 * focus can move in between). The lists are interpolated from this module's
 * own constants — never caller data — so the two implementations cannot
 * drift.
 */
const AX_SECURE_GUARD_SCRIPT = `
var SECURE_NAMES = ${JSON.stringify(
  [...SECURE_FIELD_SUBROLES, ...SECURE_FIELD_ROLES].map((n) => n.toLowerCase()),
)};
var TEXT_ENTRY_ROLES = ${JSON.stringify(TEXT_ENTRY_ROLES.map((n) => n.toLowerCase()))};
function isSecureLive(role, subrole) {
  if (!role) return true;
  var r = String(role).toLowerCase();
  var s = (subrole === null || subrole === undefined) ? "" : String(subrole).toLowerCase();
  if (SECURE_NAMES.indexOf(s) >= 0) return true;
  if (SECURE_NAMES.indexOf(r) >= 0) return true;
  if (TEXT_ENTRY_ROLES.indexOf(r) >= 0 && s === "") return true;
  return false;
}
`;

/** argv: [app, indexPath, expectedRole]. Walks to the element, compares the
 * live role to expectedRole; on match performs AXPress and returns
 * { success:true }, on mismatch returns { stale:true, actualRole }. */
const AX_CLICK_SCRIPT = `
${AX_ROLE_HELPER_SCRIPT}
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

/** argv: [x, y]. Clicks at a screen coordinate (global coordinates) — the
 * entry point Tier 3 (plan 15-05) uses for vision-grounded clicks.
 *
 * 15 CR-02: the coordinate form of `click` is only valid when sent to a
 * PROCESS object with the named `at:` parameter — the System Events sdef says
 * so ("when sent to a 'process' object, the { x, y } location at which to
 * click"), and `Application("System Events").click({x,y})` throws
 * `Can't convert types.` at parameter marshalling, before any TCC check,
 * on every invocation. */
const AX_CLICK_AT_SCRIPT = `
function run(argv) {
  const x = parseInt(argv[0], 10);
  const y = parseInt(argv[1], 10);
  const se = Application("System Events");
  const matches = se.processes.whose({ frontmost: true });
  const proc = matches[0];
  proc.click({ at: [x, y] });
  return JSON.stringify({ success: true });
}
`;

/** argv: [app, indexPath]. Inspect-only: focuses the element, reads its role
 * AND subrole, AND separately the process's AXFocusedUIElement role/subrole.
 * Types NOTHING. */
const AX_TYPE_INSPECT_SCRIPT = `
${AX_ROLE_HELPER_SCRIPT}
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
  const elementSubrole = readSubrole(el);
  let focusedRole = "";
  let focusedSubrole = "";
  try {
    const focused = proc.attributes.byName("AXFocusedUIElement").value();
    focusedRole = readRole(focused);
    focusedSubrole = readSubrole(focused);
  } catch (e) {}
  return JSON.stringify({
    elementRole: elementRole,
    elementSubrole: elementSubrole,
    focusedRole: focusedRole,
    focusedSubrole: focusedSubrole,
  });
}
`;

/** argv: [app, indexPath, text, submit01, expectedRole, expectedSubrole].
 * Only reached after the TS-side refusal decision has cleared. RE-READS the
 * target's role/subrole (and the live focused element) immediately before
 * synthesizing anything and aborts with a `refused` sentinel if the
 * observation the decision was made against no longer holds (15 WR-03). */
const AX_TYPE_KEYSTROKE_SCRIPT = `
${AX_ROLE_HELPER_SCRIPT}
${AX_SECURE_GUARD_SCRIPT}
function run(argv) {
  const appName = argv[0];
  const indexPath = argv[1].split(".").map(Number);
  const text = argv[2];
  const submit = argv[3] === "1";
  const expectedRole = argv[4];
  const expectedSubrole = argv[5];
  const se = Application("System Events");
  const proc = se.processes.byName(appName);
  let el = proc.windows[0];
  for (let i = 0; i < indexPath.length; i++) {
    el = el.uiElements()[indexPath[i]];
  }
  try {
    el.actions.byName("AXFocus").perform();
  } catch (e) {}

  const liveRole = readRole(el);
  const liveSubrole = readSubrole(el);
  if (liveRole !== expectedRole || liveSubrole !== expectedSubrole) {
    return JSON.stringify({ refused: "focus-changed", liveRole: liveRole, liveSubrole: liveSubrole });
  }
  if (isSecureLive(liveRole, liveSubrole)) {
    return JSON.stringify({ refused: "secure-field", liveRole: liveRole, liveSubrole: liveSubrole });
  }

  var focusedRole = "";
  var focusedSubrole = "";
  try {
    const focused = proc.attributes.byName("AXFocusedUIElement").value();
    focusedRole = readRole(focused);
    focusedSubrole = readSubrole(focused);
  } catch (e) {}
  if (isSecureLive(focusedRole, focusedSubrole)) {
    return JSON.stringify({ refused: "secure-field", liveRole: focusedRole, liveSubrole: focusedSubrole });
  }

  se.keystroke(text);
  if (submit) se.keyCode(36);
  return JSON.stringify({ success: true });
}
`;

/** argv: []. Inspect-only: reads the role of whatever process/element
 * currently has focus (no ref addressing — vision-grounded click leaves
 * focus somewhere the model did not address by ref). */
const AX_TYPE_AT_FOCUS_INSPECT_SCRIPT = `
${AX_ROLE_HELPER_SCRIPT}
function run(argv) {
  const se = Application("System Events");
  const matches = se.processes.whose({ frontmost: true });
  const proc = matches[0];
  let focusedRole = "";
  let focusedSubrole = "";
  try {
    const focused = proc.attributes.byName("AXFocusedUIElement").value();
    focusedRole = readRole(focused);
    focusedSubrole = readSubrole(focused);
  } catch (e) {}
  return JSON.stringify({ focusedRole: focusedRole, focusedSubrole: focusedSubrole });
}
`;

/** argv: [text, submit01, expectedRole, expectedSubrole]. Only reached after
 * the TS-side refusal decision has cleared. Re-reads the LIVE focused element
 * immediately before the keystroke and aborts if it is not the element the
 * decision was made against (15 WR-03) — this script previously typed blindly
 * into whatever held focus at that instant. */
const AX_TYPE_AT_FOCUS_KEYSTROKE_SCRIPT = `
${AX_ROLE_HELPER_SCRIPT}
${AX_SECURE_GUARD_SCRIPT}
function run(argv) {
  const text = argv[0];
  const submit = argv[1] === "1";
  const expectedRole = argv[2];
  const expectedSubrole = argv[3];
  const se = Application("System Events");
  const matches = se.processes.whose({ frontmost: true });
  const proc = matches[0];

  var liveRole = "";
  var liveSubrole = "";
  try {
    const focused = proc.attributes.byName("AXFocusedUIElement").value();
    liveRole = readRole(focused);
    liveSubrole = readSubrole(focused);
  } catch (e) {}

  if (liveRole !== expectedRole || liveSubrole !== expectedSubrole) {
    return JSON.stringify({ refused: "focus-changed", liveRole: liveRole, liveSubrole: liveSubrole });
  }
  if (isSecureLive(liveRole, liveSubrole)) {
    return JSON.stringify({ refused: "secure-field", liveRole: liveRole, liveSubrole: liveSubrole });
  }

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

/**
 * Interpret a keystroke script's stdout. The script re-verifies its target
 * immediately before typing (15 WR-03), so its payload is authoritative:
 * a `refused` sentinel becomes a structured refusal, and anything that is
 * not an explicit success is treated as a failure rather than reported as a
 * successful keystroke.
 */
function interpretKeystrokeOutput(stdout: string, success: AxActionResult): AxActionResult {
  let out: { success?: boolean; refused?: string; liveRole?: string };
  try {
    out = JSON.parse(stdout) as typeof out;
  } catch {
    return { ok: false, error: "failed to parse type result", kind: "unknown" };
  }
  if (out.refused === "secure-field") {
    return { ok: false, error: SECURE_FIELD_REFUSAL, kind: "unknown", refused: "secure-field" };
  }
  if (out.refused === "focus-changed") {
    const seen = out.liveRole ? ` (focus is now ${out.liveRole})` : "";
    return {
      ok: false,
      error: `${FOCUS_CHANGED_REFUSAL}${seen}`,
      kind: "unknown",
      refused: "focus-changed",
    };
  }
  if (out.success !== true) {
    return { ok: false, error: "typing did not report success", kind: "unknown" };
  }
  return success;
}

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

    // 15 CR-02: verify the script's own payload rather than trusting
    // exitCode 0 — a click that never happened must not be reported as
    // success to the agent (and to the human who approved it).
    let parsedOut: { success?: boolean };
    try {
      parsedOut = JSON.parse(result.stdout) as { success?: boolean };
    } catch {
      return { ok: false, error: "failed to parse clickAt result", kind: "unknown" };
    }
    if (parsedOut.success !== true) {
      return { ok: false, error: "click did not report success", kind: "unknown" };
    }

    return { ok: true, clicked: `${point.x},${point.y}` };
  }

  /**
   * Type `text` into the element at `ref`. Two-call structure: an
   * inspect-only first call reads the element's role AND SUBROLE plus the
   * process's AXFocusedUIElement role AND SUBROLE; if either pair looks
   * secure (or undeterminable), a refusal is returned with NO second call and
   * the secret text never reaches a spawn. Only when both pairs are
   * non-secure does a second call keystroke the text (and, if `submit`, a
   * Return).
   */
  async type(ref: string, text: string, submit?: boolean): Promise<AxActionResult> {
    const parsed = parseAxRef(ref);
    if (!parsed) {
      return { ok: false, error: "malformed ref — re-run mac_ui_snapshot", kind: "unknown" };
    }

    const inspect = await this.script.runJxa(AX_TYPE_INSPECT_SCRIPT, [parsed.app, parsed.indexPath.join(".")]);
    if (!inspect.ok) return inspect;

    let roles: {
      elementRole?: string;
      elementSubrole?: string;
      focusedRole?: string;
      focusedSubrole?: string;
    };
    try {
      roles = JSON.parse(inspect.stdout) as typeof roles;
    } catch {
      return { ok: false, error: "failed to parse type inspection result", kind: "unknown" };
    }

    if (
      isSecureTarget(roles.elementRole, roles.elementSubrole) ||
      isSecureTarget(roles.focusedRole, roles.focusedSubrole)
    ) {
      return { ok: false, error: SECURE_FIELD_REFUSAL, kind: "unknown", refused: "secure-field" };
    }

    const keystroke = await this.script.runJxa(AX_TYPE_KEYSTROKE_SCRIPT, [
      parsed.app,
      parsed.indexPath.join("."),
      text,
      submit ? "1" : "0",
      roles.elementRole ?? "",
      roles.elementSubrole ?? "",
    ]);
    if (!keystroke.ok) return keystroke;
    return interpretKeystrokeOutput(keystroke.stdout, { ok: true, typed: ref });
  }

  /**
   * Type `text` into whatever currently has focus (no ref addressing) — the
   * variant Tier 3 (plan 15-05) uses since a vision-grounded click leaves
   * focus somewhere the model did not address by ref. Identical two-call,
   * refuse-before-second-call structure as `type`, plus the WR-03
   * re-verification inside the keystroke call: if focus moved between the
   * two spawns the keystroke is abandoned rather than delivered to whatever
   * arrived (an auth dialog, another app).
   */
  async typeAtFocus(text: string, submit?: boolean): Promise<AxActionResult> {
    const inspect = await this.script.runJxa(AX_TYPE_AT_FOCUS_INSPECT_SCRIPT, []);
    if (!inspect.ok) return inspect;

    let roles: { focusedRole?: string; focusedSubrole?: string };
    try {
      roles = JSON.parse(inspect.stdout) as typeof roles;
    } catch {
      return { ok: false, error: "failed to parse focus inspection result", kind: "unknown" };
    }

    if (isSecureTarget(roles.focusedRole, roles.focusedSubrole)) {
      return { ok: false, error: SECURE_FIELD_REFUSAL, kind: "unknown", refused: "secure-field" };
    }

    const keystroke = await this.script.runJxa(AX_TYPE_AT_FOCUS_KEYSTROKE_SCRIPT, [
      text,
      submit ? "1" : "0",
      roles.focusedRole ?? "",
      roles.focusedSubrole ?? "",
    ]);
    if (!keystroke.ok) return keystroke;
    return interpretKeystrokeOutput(keystroke.stdout, { ok: true, typed: "focus" });
  }

  /** Press an allowlisted key. Any key outside ALLOWED_KEYS is refused
   * pre-spawn. */
  async pressKey(key: string): Promise<AxActionResult> {
    const keyCode = ALLOWED_KEYS.get(key);
    if (typeof keyCode !== "number") {
      return { ok: false, error: `key "${key}" is not in the allowed key list`, kind: "unknown" };
    }

    const result = await this.script.runJxa(AX_PRESS_KEY_SCRIPT, [String(keyCode)]);
    if (!result.ok) return result;
    return { ok: true, pressed: key };
  }
}
