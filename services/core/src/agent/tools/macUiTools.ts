/**
 * Mac control tools (Tier 2 — Accessibility UI actions, phase 15). Desktop
 * analog of browserTools.ts's `browser_snapshot` -> `browser_click`/
 * `browser_type` loop, for apps with no scripting dictionary:
 *
 *   mac_ui_snapshot     readOnly:true   free read — the text-only model's "eyes"
 *   mac_ui_click        readOnly:false  → GATED (mac_action)
 *   mac_ui_type         readOnly:false  → GATED (mac_action) — secure fields
 *                                        (AXSecureTextField SUBROLE, 15
 *                                        CR-01) refused before any keystroke
 *                                        is synthesized (D-03)
 *   mac_ui_press_key    readOnly:false  → GATED (mac_action)
 *
 * All four tools tag their output as external, untrusted content (mandatory,
 * not conditional): a snapshot can surface text from a web page or document
 * open in the target app, so reactLoop.ts taints the run UNCONDITIONALLY for
 * every one of these tools and every later gated action escalates — exactly
 * like the browser slice (feature 17's decision table already requires
 * approval for mac_action regardless; this taint propagation is the
 * additional guarantee this file provides).
 *
 * ACTIONS ARE BOUND TO THE PERCEPTION THEY CAME FROM (15 security audit
 * UF-03, the Tier 2 analog of Tier 3's WR-12 fix): `mac_ui_click` and
 * `mac_ui_type` require a human-readable `element` string, and that string is
 * what a human reads in the approval prompt. It used to be surfaced in the
 * approval args and then NEVER checked — so a human could approve "click the
 * Save button" while an unrelated ref fired. Both acting tools now demand a
 * ref that a RECENT `mac_ui_snapshot` actually produced, and refuse when the
 * model's `element` does not describe the element that snapshot recorded at
 * that ref. The approved target is the acted-on target.
 *
 * Note what this does NOT promise (15 WR-11): the ref's index path is
 * positional and axActions.ts's live re-check is role-only, so a different
 * element of the SAME role and a matching label that moved into that position
 * still passes. Re-run the snapshot after anything that may change the screen.
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { MacCommandRunner } from "../../mac/commandRunner.js";
import { ScriptRunner } from "../../mac/scriptRunner.js";
import { AxSnapshotRunner } from "../../mac/axSnapshot.js";
import { AxActionRunner } from "../../mac/axActions.js";
import { labelsMatch } from "../../mac/labelMatch.js";

/** How long a mac_ui_snapshot's elements stay usable for a bound action.
 * Beyond this the UI has almost certainly moved on and the approval prompt
 * would describe a stale world. Mirrors Tier 3's CAPTURE_TTL_MS. */
export const MAC_UI_SNAPSHOT_TTL_MS = 5 * 60_000;

/** How many snapshot elements are retained for binding (~3 full snapshots at
 * axSnapshot's AX_MAX_ELEMENTS = 200). Oldest are evicted first. */
export const MAC_UI_MAX_TRACKED_ELEMENTS = 600;

interface SeenElement {
  title: string;
  role: string;
  subrole: string;
  seenAt: number;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const SnapshotSchema = z.object({
  app: z
    .string()
    .min(1)
    .optional()
    .describe("App name to snapshot; defaults to the frontmost app when omitted"),
});

const ClickSchema = z.object({
  element: z.string().min(1).describe("Human-readable element description"),
  ref: z.string().min(1).describe("Exact element ref from the latest mac_ui_snapshot"),
});

const TypeSchema = z.object({
  element: z.string().min(1).describe("Human-readable element description"),
  ref: z.string().min(1).describe("Exact element ref from the latest mac_ui_snapshot"),
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
});

const PressKeySchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      "Key to press: Enter, Return, Tab, Escape, Space, Delete, ArrowUp, ArrowDown, ArrowLeft, or ArrowRight",
    ),
});

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build the four Tier 2 Mac-control UI tools over an injected
 * MacCommandRunner and register their phase-15 risk metadata.
 */
export function makeMacUiTools(
  run: MacCommandRunner,
  opts?: {
    /** Clock seam for snapshot TTLs. Defaults to Date.now. */
    now?: () => number;
  },
): Tool[] {
  const script = new ScriptRunner(run);
  const snapshotRunner = new AxSnapshotRunner(script);
  const actionRunner = new AxActionRunner(script);
  const now = opts?.now ?? (() => Date.now());

  // UF-03: what the last few snapshots actually reported, keyed by ref. This
  // is the perception an action must be bound to — without it, the `element`
  // string a human approves is unverifiable decoration.
  const seen = new Map<string, SeenElement>();

  function recordSnapshot(
    elements: { ref: string; role: string; subrole: string; title: string }[],
  ): void {
    const seenAt = now();
    for (const [ref, record] of seen) {
      if (seenAt - record.seenAt > MAC_UI_SNAPSHOT_TTL_MS) seen.delete(ref);
    }
    for (const element of elements) {
      // Re-inserting refreshes insertion order, so eviction stays oldest-first.
      seen.delete(element.ref);
      seen.set(element.ref, {
        title: element.title,
        role: element.role,
        subrole: element.subrole,
        seenAt,
      });
    }
    while (seen.size > MAC_UI_MAX_TRACKED_ELEMENTS) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  /**
   * Bind an action to the perception it claims to come from: the ref must
   * have been produced by a recent mac_ui_snapshot, and the model's
   * human-readable `element` must describe what that snapshot recorded there.
   * Returns a structured refusal (never throws) so the ReAct loop can recover
   * by taking a fresh snapshot.
   */
  function bindToSnapshot(
    ref: string,
    element: string,
  ): { ok: true } | { ok: false; error: string } {
    const record = seen.get(ref);
    if (!record) {
      return {
        ok: false,
        error:
          `ref "${ref}" was not produced by a recent mac_ui_snapshot — an action must reference ` +
          `the snapshot that showed it. Run mac_ui_snapshot and use a ref from its output.`,
      };
    }
    if (now() - record.seenAt > MAC_UI_SNAPSHOT_TTL_MS) {
      seen.delete(ref);
      return {
        ok: false,
        error:
          `ref "${ref}" is from an expired mac_ui_snapshot — the UI may have changed since. ` +
          `Re-run mac_ui_snapshot and use a fresh ref.`,
      };
    }
    if (!labelsMatch(record.title, element)) {
      return {
        ok: false,
        error:
          `element description "${element}" does not match the element at ${ref} ` +
          `("${record.title}" ${record.role}) — the approval prompt must describe the action ` +
          `that actually runs. Re-run mac_ui_snapshot if the screen has changed.`,
      };
    }
    return { ok: true };
  }

  const tools: Tool[] = [
    {
      name: "mac_ui_snapshot",
      description:
        "Read the UI tree of an app that has no scripting dictionary — the desktop equivalent " +
        "of browser_snapshot. Returns a capped, indented tree of element refs required by " +
        "mac_ui_click and mac_ui_type, each line showing the element's role and (when present) " +
        "its subrole — an AXSecureTextField subrole marks a password field, which mac_ui_type " +
        "always refuses. Refs go stale when the UI changes; re-run this after any action that " +
        "may have changed the screen. Read-only, no approval required.",
      schema: SnapshotSchema,
      readOnly: true,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { app } = SnapshotSchema.parse(rawArgs ?? {});
        const result = await snapshotRunner.snapshot(app !== undefined ? { app } : {});
        // UF-03: remember what this snapshot reported, so a later click/type
        // can be verified against it.
        if (result.ok) recordSnapshot(result.elements);
        return result;
      },
    },
    {
      name: "mac_ui_click",
      description:
        "Click a UI element in an app that has no scripting dictionary (requires approval). Use " +
        "the ref from the latest mac_ui_snapshot, and describe what you are clicking in that " +
        "snapshot's own words: the click is refused unless the ref came from a recent snapshot " +
        "AND your element description matches what that snapshot recorded there, because that " +
        "description is what the human sees in the approval prompt. The element's ROLE at that " +
        "index path is also re-checked live and a role mismatch is refused — but the path is " +
        "positional, so a different element of the SAME role that has moved into that position " +
        "would still be clicked. Re-run mac_ui_snapshot after any action that may have changed " +
        "the screen.",
      schema: ClickSchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { ref, element } = ClickSchema.parse(rawArgs);
        const bound = bindToSnapshot(ref, element);
        if (!bound.ok) return bound;
        return actionRunner.click(ref);
      },
    },
    {
      name: "mac_ui_type",
      description:
        "Type text into a UI element in an app that has no scripting dictionary (requires " +
        "approval). Use the ref from the latest mac_ui_snapshot, and describe the field in that " +
        "snapshot's own words: typing is refused unless the ref came from a recent snapshot AND " +
        "your element description matches what that snapshot recorded there, because that " +
        "description is what the human sees in the approval prompt. The element's ROLE at that " +
        "index path is also re-checked live and a stale ref is refused before anything is typed — " +
        "but the path is positional, so a different element of the SAME role that has moved " +
        "into that position would still be typed into. Jarvis never types credentials — typing " +
        "into a secure/password field (role or AXSecureTextField subrole), or a field whose " +
        "role cannot be determined, or a text field whose subrole cannot be read at all, is " +
        "refused before any keystroke is synthesized.",
      schema: TypeSchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { ref, element, text, submit } = TypeSchema.parse(rawArgs);
        const bound = bindToSnapshot(ref, element);
        if (!bound.ok) return bound;
        return actionRunner.type(ref, text, submit);
      },
    },
    {
      name: "mac_ui_press_key",
      description:
        "Press a keyboard key in an app that has no scripting dictionary (requires approval). " +
        "Allowed keys: Enter, Return, Tab, Escape, Space, Delete, ArrowUp, ArrowDown, ArrowLeft, " +
        "ArrowRight.",
      schema: PressKeySchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { key } = PressKeySchema.parse(rawArgs);
        return actionRunner.pressKey(key);
      },
    },
  ];

  // Phase 15 risk metadata. Gated tools ride the LOCKED decision-table class
  // mac_action (require_approval, always) — do not weaken.
  registerToolMeta("mac_ui_snapshot", { sideEffects: "read_only", reversible: true });
  registerToolMeta("mac_ui_click", { sideEffects: "mac_action", reversible: false });
  registerToolMeta("mac_ui_type", { sideEffects: "mac_action", reversible: false });
  registerToolMeta("mac_ui_press_key", { sideEffects: "mac_action", reversible: false });

  return tools;
}
