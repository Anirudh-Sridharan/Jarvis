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
 * constantly, roles do not — so a later action re-reads the live role at
 * that address and refuses if it no longer matches.
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

function capTree(text: string): string {
  if (text.length <= AX_TEXT_CAP) return text;
  return `${text.slice(0, AX_TEXT_CAP)}\n[truncated ${text.length - AX_TEXT_CAP} chars]`;
}

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
  const parts = ref.split("#");
  if (parts.length !== 3) return null;
  const [app, pathStr, role] = parts;
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
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawAxElement {
  indexPath: number[];
  role: string;
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

    const role = readProp(function () { return el.role(); }, "");
    let title = readProp(function () { return el.title(); }, "");
    if (!title) title = readProp(function () { return el.description(); }, "");
    if (!title) title = readProp(function () { return el.value(); }, "");
    const pos = readProp(function () { return el.position(); }, [0, 0]);
    const size = readProp(function () { return el.size(); }, [0, 0]);

    elements.push({
      indexPath: indexPath,
      role: role,
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

    let parsed: RawAxSnapshot;
    try {
      parsed = JSON.parse(result.stdout) as RawAxSnapshot;
    } catch {
      return { ok: false, error: "failed to parse AX snapshot output", kind: "unknown" };
    }

    const elements: AxElement[] = parsed.elements.map((e) => ({
      ref: formatAxRef(parsed.app, e.indexPath, e.role),
      role: e.role,
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
      return `${indent}[${el.ref}] ${el.role} "${el.title}" (${el.x},${el.y}) ${el.width}x${el.height}`;
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
