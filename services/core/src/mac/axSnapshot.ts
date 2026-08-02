/**
 * axSnapshot.ts — Tier 2 Accessibility UI tree enumeration (phase 15, plan
 * 15-04). This is the desktop analog of browserTools.ts's `browser_snapshot`:
 * one free, read-only pass over System Events' UI tree for an app that has
 * no scripting dictionary, capped and rendered so the text-only model can
 * "see" it.
 *
 * Ref format: `<app>#<i.j.k>#<role>` — a ref encodes the ADDRESS (an index
 * path from the front window down to the element) plus the role captured at
 * snapshot time, rather than an opaque handle, because refs must be
 * resolvable by a LATER, stateless `osascript` process. The embedded role is
 * the staleness check axActions.ts enforces: element titles change
 * constantly, roles do not — so a later action re-reads the live ROLE at
 * that address and refuses if it no longer matches. Note the exact scope of
 * that check (15 WR-11): the index path is positional, so a same-role
 * element that moved into that position passes. It is a role re-check, NOT
 * an element-identity guarantee — re-run the snapshot after any action that
 * may have changed the screen.
 *
 * Each element also carries its SUBROLE (15 CR-01). macOS reports a password
 * field as role `AXTextField` with subrole `AXSecureTextField` — the subrole
 * is the load-bearing attribute for the D-03 credential guard, so it is read
 * here and by axActions.ts through the SAME shared JXA helper
 * (AX_ROLE_HELPER_SCRIPT below), which distinguishes "this element has no
 * subrole" (SUBROLE_NONE) from "the subrole could not be read" ("").
 *
 * Live-verified failure signature (15-RESEARCH.md, macOS 26.5): enumerating
 * process NAMES succeeds without Accessibility, but the very next call
 * touching `.windows` on the same process fails in milliseconds with
 * `osascript is not allowed assistive access. (-25211)` — classified here via
 * ScriptRunner's inherited macFailure()/tccErrors.ts degrade-never-crash path.
 */

import { ScriptRunner } from "./scriptRunner.js";
import type { TccFailureKind } from "./tccErrors.js";

/** Hard cap on the number of elements a single snapshot walk will emit. */
export const AX_MAX_ELEMENTS = 200;

/** Hard cap on how many levels deep a single snapshot walk descends. */
export const AX_MAX_DEPTH = 5;

/** Hard cap on the rendered `tree` text returned to the loop. */
export const AX_TEXT_CAP = 16_000;

/** Render the raw subrole for display: both "definitively absent"
 * (SUBROLE_NONE) and "unreadable" ("") become an empty string. The
 * absent-vs-unreadable distinction only matters to axActions.ts's guard,
 * which reads the raw value from its own inspect call. */
function normalizeSubrole(subrole: string | undefined): string {
  if (!subrole || subrole === SUBROLE_NONE) return "";
  return subrole;
}

function capTree(text: string): string {
  if (text.length <= AX_TEXT_CAP) return text;
  return `${text.slice(0, AX_TEXT_CAP)}\n[truncated ${text.length - AX_TEXT_CAP} chars]`;
}

/**
 * Sentinel returned by the shared `readSubrole()` JXA helper when an element
 * DEFINITIVELY has no subrole (System Events reports `missing value`), as
 * distinct from `""` which means the subrole attribute could not be READ at
 * all. axActions.ts's D-08 fail-closed rule keys on exactly that distinction:
 * an unreadable subrole on a text-entry element is treated as secure, while a
 * definitively-absent one (every ordinary AXTextField) is not — otherwise the
 * guard would refuse every normal text field on real macOS.
 */
export const SUBROLE_NONE = "__none__";

/**
 * Shared JXA helper prepended to every script that needs an element's role or
 * subrole (this file's snapshot walk and axActions.ts's inspect/keystroke
 * scripts). Fixed source text — the only interpolation is this module's own
 * SUBROLE_NONE constant, never caller data, so the two can never drift.
 */
export const AX_ROLE_HELPER_SCRIPT = `
function readRole(el) {
  try { var r = el.role(); if (r) return String(r); } catch (e) {}
  try { var v = el.attributes.byName("AXRole").value(); if (v) return String(v); } catch (e) {}
  return "";
}
function readSubrole(el) {
  // "${SUBROLE_NONE}" = the element definitively has NO subrole.
  // ""               = the subrole could not be read at all -> caller fails closed.
  try {
    var s = el.subrole();
    if (s) return String(s);
    if (s === null || s === undefined || s === "") return "${SUBROLE_NONE}";
  } catch (e) {}
  try {
    var v = el.attributes.byName("AXSubrole").value();
    if (v) return String(v);
    if (v === null || v === undefined || v === "") return "${SUBROLE_NONE}";
  } catch (e) {}
  return "";
}
`;

// ── Ref codec ─────────────────────────────────────────────────────────────────

/**
 * Encode an address (app + index path + role captured at snapshot time) into
 * a stable, later-resolvable ref string: `<app>#<i.j.k>#<role>`.
 */
export function formatAxRef(app: string, indexPath: number[], role: string): string {
  return `${app}#${indexPath.join(".")}#${role}`;
}

/**
 * Decode a ref produced by formatAxRef. Returns null for any malformed shape
 * (missing separators, non-numeric path segment, empty app) — the caller
 * (axActions.ts) must refuse rather than spawn on a null parse.
 */
export function parseAxRef(ref: string): { app: string; indexPath: number[]; role: string } | null {
  // IN-05: split from the RIGHT — a plain split("#") required exactly 3 parts,
  // so an app whose name contains "#" (e.g. "C#") produced 4 and every Tier 2
  // action against it refused permanently as "malformed".
  const roleSep = ref.lastIndexOf("#");
  if (roleSep <= 0) return null;
  const pathSep = ref.lastIndexOf("#", roleSep - 1);
  if (pathSep <= 0) return null;
  const app = ref.slice(0, pathSep);
  const pathStr = ref.slice(pathSep + 1, roleSep);
  const role = ref.slice(roleSep + 1);
  if (!app || !pathStr || !role) return null;

  const segments = pathStr.split(".");
  const indexPath: number[] = [];
  for (const seg of segments) {
    if (!/^\d+$/.test(seg)) return null;
    indexPath.push(Number(seg));
  }
  if (indexPath.length === 0) return null;

  return { app, indexPath, role };
}

// ── Snapshot shapes ───────────────────────────────────────────────────────────

export interface AxElement {
  ref: string;
  role: string;
  /** Subrole captured at snapshot time; `""` when absent or unreadable.
   * `AXSecureTextField` here marks a password field (15 CR-01). */
  subrole: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawAxElement {
  indexPath: number[];
  role: string;
  subrole?: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawAxSnapshot {
  app: string;
  window: string | null;
  truncated: boolean;
  elements: RawAxElement[];
}

/**
 * Runtime shape guard for the script's stdout (15 CR-04). Mirrors the
 * sibling modules' pattern (screenshotRunner.ts's isValidRect,
 * computerUseTools.ts's parseVisionReply) so `snapshot()` really never
 * throws. Per-element numeric fields are read defensively downstream, so
 * only the fields the mapping actually indexes into are required here.
 */
function isRawAxSnapshot(value: unknown): value is RawAxSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  if (typeof o["app"] !== "string") return false;
  const elements = o["elements"];
  if (!Array.isArray(elements)) return false;
  return elements.every((e) => {
    if (typeof e !== "object" || e === null) return false;
    const el = e as Record<string, unknown>;
    return Array.isArray(el["indexPath"]) && typeof el["role"] === "string";
  });
}

export type AxSnapshotResult =
  | {
      ok: true;
      app: string;
      window: string | null;
      truncated: boolean;
      elements: AxElement[];
      tree: string;
    }
  | { ok: false; error: string; kind: TccFailureKind };

// ── Fixed JXA script body (never string-concatenated with untrusted data) ─────
//
// argv: [targetProcessNameOrEmpty, maxDepth, maxElements]. Every per-element
// property read is individually try/caught so one unreadable attribute
// yields an empty field instead of aborting the whole walk.

const AX_SNAPSHOT_SCRIPT = `
${AX_ROLE_HELPER_SCRIPT}
function run(argv) {
  const targetName = argv[0];
  const maxDepth = parseInt(argv[1], 10);
  const maxElements = parseInt(argv[2], 10);
  const se = Application("System Events");

  let proc;
  if (targetName) {
    proc = se.processes.byName(targetName);
  } else {
    const matches = se.processes.whose({ frontmost: true });
    proc = matches[0];
  }
  const appName = proc.name();

  let win;
  let windowName = null;
  try {
    win = proc.windows[0];
    windowName = win.name();
  } catch (e) {
    return JSON.stringify({ app: appName, window: null, truncated: false, elements: [] });
  }

  const elements = [];
  let truncated = false;

  function readProp(fn, fallback) {
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function walk(el, indexPath, depth) {
    if (elements.length >= maxElements) { truncated = true; return; }

    const role = readRole(el);
    const subrole = readSubrole(el);
    let title = readProp(function () { return el.title(); }, "");
    if (!title) title = readProp(function () { return el.description(); }, "");
    if (!title) title = readProp(function () { return el.value(); }, "");
    const pos = readProp(function () { return el.position(); }, [0, 0]);
    const size = readProp(function () { return el.size(); }, [0, 0]);

    elements.push({
      indexPath: indexPath,
      role: role,
      subrole: subrole,
      title: String(title || ""),
      x: pos[0],
      y: pos[1],
      width: size[0],
      height: size[1],
    });

    if (depth >= maxDepth) return;

    let children = [];
    try {
      children = el.uiElements();
    } catch (e) {
      children = [];
    }
    for (let i = 0; i < children.length; i++) {
      if (elements.length >= maxElements) { truncated = true; break; }
      walk(children[i], indexPath.concat([i]), depth + 1);
    }
  }

  let topChildren = [];
  try {
    topChildren = win.uiElements();
  } catch (e) {
    topChildren = [];
  }
  for (let i = 0; i < topChildren.length; i++) {
    if (elements.length >= maxElements) { truncated = true; break; }
    walk(topChildren[i], [i], 0);
  }

  return JSON.stringify({ app: appName, window: windowName, truncated: truncated, elements: elements });
}
`;

export class AxSnapshotRunner {
  constructor(private readonly script: ScriptRunner = new ScriptRunner()) {}

  /**
   * Enumerate the front window's UI tree for `opts.app` (or the frontmost
   * process when omitted), capped at `opts.maxElements`/`opts.maxDepth`.
   * Never throws — parse failures and TCC failures both degrade to a
   * structured `{ ok: false, ... }` result.
   */
  async snapshot(
    opts: { app?: string; maxElements?: number; maxDepth?: number } = {},
  ): Promise<AxSnapshotResult> {
    const maxDepth = opts.maxDepth ?? AX_MAX_DEPTH;
    const maxElements = opts.maxElements ?? AX_MAX_ELEMENTS;
    const appArg = opts.app ?? "";

    const result = await this.script.runJxa(AX_SNAPSHOT_SCRIPT, [
      appArg,
      String(maxDepth),
      String(maxElements),
    ]);
    if (!result.ok) return result;

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return { ok: false, error: "failed to parse AX snapshot output", kind: "unknown" };
    }
    // 15 CR-04: valid JSON is not the expected SHAPE. `{}`, `"hello"` and
    // `{"elements":null}` are all reachable (the script's early return, stray
    // stdout ahead of the JSON) and each threw a TypeError out of the
    // documented never-throws contract before this guard existed.
    if (!isRawAxSnapshot(raw)) {
      return { ok: false, error: "AX snapshot output had an unexpected shape", kind: "unknown" };
    }
    const parsed: RawAxSnapshot = raw;

    const elements: AxElement[] = parsed.elements.map((e) => ({
      ref: formatAxRef(parsed.app, e.indexPath, e.role),
      role: e.role,
      subrole: normalizeSubrole(e.subrole),
      title: e.title ?? "",
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
    }));

    const treeLines = parsed.elements.map((e, i) => {
      const depth = Math.max(0, e.indexPath.length - 1);
      const indent = "  ".repeat(depth);
      const el = elements[i]!;
      const subrole = el.subrole ? ` (${el.subrole})` : "";
      return `${indent}[${el.ref}] ${el.role}${subrole} "${el.title}" (${el.x},${el.y}) ${el.width}x${el.height}`;
    });

    return {
      ok: true,
      app: parsed.app,
      window: parsed.window,
      truncated: parsed.truncated,
      elements,
      tree: capTree(treeLines.join("\n")),
    };
  }
}
