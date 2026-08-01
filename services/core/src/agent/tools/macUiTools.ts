/**
 * Mac control tools (Tier 2 — Accessibility UI actions, phase 15). Desktop
 * analog of browserTools.ts's `browser_snapshot` -> `browser_click`/
 * `browser_type` loop, for apps with no scripting dictionary:
 *
 *   mac_ui_snapshot     readOnly:true   free read — the text-only model's "eyes"
 *   mac_ui_click        readOnly:false  → GATED (mac_action)
 *   mac_ui_type         readOnly:false  → GATED (mac_action) — secure fields
 *                                        refused before any keystroke is
 *                                        synthesized (D-03)
 *   mac_ui_press_key    readOnly:false  → GATED (mac_action)
 *
 * All four tools tag their output as external, untrusted content (mandatory,
 * not conditional): a snapshot can surface text from a web page or document
 * open in the target app, so reactLoop.ts taints the run UNCONDITIONALLY for
 * every one of these tools and every later gated action escalates — exactly
 * like the browser slice (feature 17's decision table already requires
 * approval for mac_action regardless; this taint propagation is the
 * additional guarantee this file provides).
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { MacCommandRunner } from "../../mac/commandRunner.js";
import { ScriptRunner } from "../../mac/scriptRunner.js";
import { AxSnapshotRunner } from "../../mac/axSnapshot.js";
import { AxActionRunner } from "../../mac/axActions.js";

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
export function makeMacUiTools(run: MacCommandRunner): Tool[] {
  const script = new ScriptRunner(run);
  const snapshotRunner = new AxSnapshotRunner(script);
  const actionRunner = new AxActionRunner(script);

  const tools: Tool[] = [
    {
      name: "mac_ui_snapshot",
      description:
        "Read the UI tree of an app that has no scripting dictionary — the desktop equivalent " +
        "of browser_snapshot. Returns a capped, indented tree of element refs required by " +
        "mac_ui_click and mac_ui_type. Refs go stale when the UI changes; re-run this after any " +
        "action that may have changed the screen. Read-only, no approval required.",
      schema: SnapshotSchema,
      readOnly: true,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { app } = SnapshotSchema.parse(rawArgs ?? {});
        return snapshotRunner.snapshot(app !== undefined ? { app } : {});
      },
    },
    {
      name: "mac_ui_click",
      description:
        "Click a UI element in an app that has no scripting dictionary (requires approval). Use " +
        "the ref from the latest mac_ui_snapshot — a stale ref (from an outdated snapshot) is " +
        "refused rather than applied to whatever element now occupies that position.",
      schema: ClickSchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { ref } = ClickSchema.parse(rawArgs);
        return actionRunner.click(ref);
      },
    },
    {
      name: "mac_ui_type",
      description:
        "Type text into a UI element in an app that has no scripting dictionary (requires " +
        "approval). Use the ref from the latest mac_ui_snapshot. Jarvis never types credentials " +
        "— typing into a secure/password field, or a field whose role cannot be determined, is " +
        "refused before any keystroke is synthesized.",
      schema: TypeSchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { ref, text, submit } = TypeSchema.parse(rawArgs);
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
