/**
 * Mac control tools (Tier 1 — deterministic control, phase 15). Curated
 * surface over the injected Tier 1 native runners (openRunner.ts,
 * scriptRunner.ts, shortcutsRunner.ts), mirroring browserTools.ts
 * structurally:
 *
 *   mac_list_apps       readOnly:true   free read — process enumeration only
 *   mac_frontmost_app   readOnly:true   free read — process name + best-effort window title
 *   mac_list_shortcuts  readOnly:true   free read — named Shortcuts, not their contents
 *   mac_open            readOnly:false  → GATED (mac_action) — opens the user's
 *                                          REAL apps/default browser, NOT the
 *                                          isolated-profile equivalent of
 *                                          browser_navigate (15-RESEARCH.md
 *                                          Anti-Patterns)
 *   mac_run_script      readOnly:false  → GATED (mac_action) — a script CAN
 *                                          ultimately reach a shell; the
 *                                          denylist is a speed bump, the
 *                                          approval gate is the control
 *                                          (15 CR-03, scriptRunner.ts header)
 *   mac_run_shortcut    readOnly:false  → GATED (mac_action) — shortcut
 *                                          contents are not inspectable before
 *                                          execution (Pitfall 4 / T-15-11)
 *
 * TAINT (15 WR-04): `mac_run_script` and `mac_frontmost_app` DO set
 * returnsExternalContent. The model authors the script, but it does not
 * author the STDOUT — a scripting dictionary is a first-class route to
 * arbitrary app/document/web content
 * (`Application("Safari").windows[0].currentTab.text()`,
 * `Application("Mail").selection[0].content()`), and a window title is
 * likewise app-controlled text (a web page title, a document name). Both
 * therefore taint the run exactly like the Tier 2/3 tools, so later gated
 * actions pick up `taint_escalation` and always-allow grants stop applying.
 * `mac_list_apps` and `mac_list_shortcuts` return only names the OS and the
 * user chose, and stay untainted.
 *
 * Scope note: a persisted "recipe/skill file format" for reusable
 * AppleScript snippets (CONTEXT.md Claude's Discretion) is deliberately NOT
 * shipped here — mac_run_script plus named Shortcuts already cover reusable
 * recipes, and a recipe registry would add a persistence/trust surface with
 * no consumer this phase.
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { MacCommandRunner } from "../../mac/commandRunner.js";
import { OpenRunner } from "../../mac/openRunner.js";
import { ScriptRunner } from "../../mac/scriptRunner.js";
import { ShortcutsRunner } from "../../mac/shortcutsRunner.js";
import { classifyTccFailure, type TccFailureKind } from "../../mac/tccErrors.js";

/** Hard cap on free-text fields returned to the loop (script stdout, window titles). */
export const MAC_TEXT_CAP = 16_000;

function capText(text: string): string {
  if (text.length <= MAC_TEXT_CAP) return text;
  return `${text.slice(0, MAC_TEXT_CAP)}\n[truncated ${text.length - MAC_TEXT_CAP} chars]`;
}

// ── Fixed JXA script bodies (never string-concatenated with untrusted data) ───

const LIST_APPS_SCRIPT = `
function run(argv) {
  const se = Application("System Events");
  const procs = se.processes();
  const names = [];
  for (let i = 0; i < procs.length; i++) {
    try {
      if (!procs[i].backgroundOnly()) names.push(procs[i].name());
    } catch (e) {}
  }
  return JSON.stringify(names);
}
`;

const FRONTMOST_APP_SCRIPT = `
function run(argv) {
  const se = Application("System Events");
  const matches = se.processes.whose({ frontmost: true });
  const frontProc = matches[0];
  const appName = frontProc.name();
  let windowTitle = null;
  let windowError = null;
  try {
    windowTitle = frontProc.windows[0].name();
  } catch (e) {
    windowError = String(e);
  }
  return JSON.stringify({ app: appName, window: windowTitle, windowError: windowError });
}
`;

// ── Schemas ───────────────────────────────────────────────────────────────────

const EmptySchema = z.object({});

const OpenTargetSchema = z
  .object({
    app: z.string().optional().describe("App name to launch, e.g. 'TextEdit' (may accompany path)"),
    bundleId: z.string().optional().describe("Bundle identifier, e.g. 'com.apple.TextEdit'"),
    url: z.string().optional().describe("Absolute http(s) URL to open in the user's REAL default browser"),
    path: z.string().optional().describe("Absolute path to a file to open"),
  })
  .superRefine((val, ctx) => {
    const provided = [val.app, val.bundleId, val.url, val.path].filter((v) => v !== undefined);
    const isAppPlusPath =
      val.app !== undefined && val.path !== undefined && val.bundleId === undefined && val.url === undefined;

    if (provided.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of app, bundleId, url, or path is required",
      });
      return;
    }
    if (provided.length > 1 && !isAppPlusPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one primary target is allowed (app may additionally accompany path)",
      });
    }
  });

const RunScriptSchema = z.object({
  language: z.enum(["javascript", "applescript"]).describe("Scripting language: javascript (JXA) or applescript"),
  script: z
    .string()
    .min(1)
    .max(8000)
    .describe("Fixed script body — NEVER interpolate untrusted/variable data into this string; use args instead"),
  args: z
    .array(z.string())
    .max(20)
    .optional()
    .describe("Variable data passed as argv, readable inside the script as argv"),
  timeoutMs: z.number().int().min(1000).max(60000).optional().describe("Per-call timeout override in ms"),
});

const RunShortcutSchema = z.object({
  name: z.string().min(1).describe("Exact name of the Shortcut to run"),
});

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build the six Tier 1 Mac-control tools over an injected MacCommandRunner
 * and register their phase-15 risk metadata.
 */
export function makeMacTools(run: MacCommandRunner): Tool[] {
  const openRunner = new OpenRunner(run);
  const scriptRunner = new ScriptRunner(run);
  const shortcutsRunner = new ShortcutsRunner(run);

  const tools: Tool[] = [
    {
      name: "mac_list_apps",
      description:
        "List the names of currently running, non-background macOS applications. " +
        "Read-only, no approval required.",
      schema: EmptySchema,
      readOnly: true,
      run: async (rawArgs: unknown) => {
        EmptySchema.parse(rawArgs ?? {});
        const result = await scriptRunner.runJxa(LIST_APPS_SCRIPT, []);
        if (!result.ok) return result;
        try {
          const apps = JSON.parse(result.stdout) as string[];
          return { ok: true, apps };
        } catch {
          return { ok: false, error: "failed to parse app list", kind: "unknown" as TccFailureKind };
        }
      },
    },
    {
      name: "mac_frontmost_app",
      description:
        "Read the frontmost macOS application's name and, best-effort, its front window's " +
        "title. Read-only, no approval required. Reading the process name never needs " +
        "Accessibility; reading the window title does — if that fails, this still succeeds " +
        "with window:null and a windowUnavailable remediation instead of failing outright.",
      schema: EmptySchema,
      readOnly: true,
      // The window title is app-controlled text (a web page title, a document
      // name) — untrusted content, not something the model authored (WR-04).
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        EmptySchema.parse(rawArgs ?? {});
        const result = await scriptRunner.runJxa(FRONTMOST_APP_SCRIPT, []);
        if (!result.ok) return result;
        let parsed: { app: string; window: string | null; windowError: string | null };
        try {
          parsed = JSON.parse(result.stdout) as {
            app: string;
            window: string | null;
            windowError: string | null;
          };
        } catch {
          return { ok: false, error: "failed to parse frontmost app info", kind: "unknown" as TccFailureKind };
        }
        if (parsed.windowError) {
          const windowUnavailable = classifyTccFailure(parsed.windowError, false);
          return { ok: true, app: parsed.app, window: null, windowUnavailable };
        }
        return { ok: true, app: parsed.app, window: parsed.window ? capText(parsed.window) : null };
      },
    },
    {
      name: "mac_list_shortcuts",
      description: "List the names of available named Shortcuts. Read-only, no approval required.",
      schema: EmptySchema,
      readOnly: true,
      run: async (rawArgs: unknown) => {
        EmptySchema.parse(rawArgs ?? {});
        return shortcutsRunner.list();
      },
    },
    {
      name: "mac_open",
      description:
        "Open an app, URL, or file via macOS Launch Services. This opens the user's REAL " +
        "applications and REAL logged-in default browser — it is explicitly NOT the " +
        "isolated-profile equivalent of browser_navigate. Always requires approval. Exactly " +
        "one of app, bundleId, url, or path may be given as the primary target (app may " +
        "additionally accompany path to open that file with that app). Only http(s) URLs " +
        "are accepted.",
      schema: OpenTargetSchema,
      readOnly: false,
      run: async (rawArgs: unknown) => {
        const parsed = OpenTargetSchema.parse(rawArgs);
        return openRunner.open(parsed);
      },
    },
    {
      name: "mac_run_script",
      description:
        "Run a script (JXA or AppleScript) against an app's own scripting dictionary. " +
        "IMPORTANT: AppleScript and JXA are full programming languages — a script can " +
        "ultimately reach a shell, read or delete files, and send messages. Jarvis rejects " +
        "the obvious shell-laundering shapes (do shell script, doShellScript, ObjC bridge, " +
        "Terminal/Script Editor/Automator, eval) before execution, but that check is a " +
        "best-effort denylist over source text, NOT a guarantee: approve only if you " +
        "understand and trust the exact script shown. Variable or untrusted data belongs in " +
        "args (readable inside the script as argv), never interpolated into script. Always " +
        "requires approval.",
      schema: RunScriptSchema,
      readOnly: false,
      // stdout can carry arbitrary app/document/web content read through the
      // target app's scripting dictionary — the model authored the script,
      // not the output (WR-04).
      returnsExternalContent: true,
      run: async (rawArgs: unknown) => {
        const { language, script, args, timeoutMs } = RunScriptSchema.parse(rawArgs);
        const opts = timeoutMs !== undefined ? { timeoutMs } : undefined;
        const result =
          language === "javascript"
            ? await scriptRunner.runJxa(script, args ?? [], opts)
            : await scriptRunner.runAppleScript(script, args ?? [], opts);
        if (!result.ok) return result;
        return { ok: true, stdout: capText(result.stdout) };
      },
    },
    {
      name: "mac_run_shortcut",
      description:
        "Run a named macOS Shortcut. IMPORTANT: shortcut contents are not inspectable " +
        "before execution — approve only if you trust it. A Shortcut can itself run shell " +
        "scripts, delete files, or send messages; Jarvis cannot statically determine what " +
        "it does beforehand. Always requires approval.",
      schema: RunShortcutSchema,
      readOnly: false,
      run: async (rawArgs: unknown) => {
        const { name } = RunShortcutSchema.parse(rawArgs);
        const result = await shortcutsRunner.run(name);
        if (!result.ok) return result;
        return { ok: true, stdout: capText(result.stdout) };
      },
    },
  ];

  // Phase 15 risk metadata. Gated tools ride the LOCKED decision-table class
  // mac_action (require_approval, always) — do not weaken.
  registerToolMeta("mac_list_apps", { sideEffects: "read_only", reversible: true });
  registerToolMeta("mac_frontmost_app", { sideEffects: "read_only", reversible: true });
  registerToolMeta("mac_list_shortcuts", { sideEffects: "read_only", reversible: true });
  registerToolMeta("mac_open", { sideEffects: "mac_action", reversible: false });
  registerToolMeta("mac_run_script", { sideEffects: "mac_action", reversible: false });
  registerToolMeta("mac_run_shortcut", { sideEffects: "mac_action", reversible: false });

  return tools;
}
