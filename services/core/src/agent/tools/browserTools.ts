/**
 * Browser tools (feature 18 — Playwright MCP slice). Curated surface, not a
 * raw MCP passthrough ("never expose raw destructive tools directly"):
 *
 *   browser_navigate   readOnly:true   GET from an isolated profile — same
 *   browser_snapshot   readOnly:true   risk envelope as web_fetch. The
 *   browser_go_back    readOnly:true   snapshot (accessibility tree) is the
 *                                      text-only model's "eyes".
 *   browser_click      readOnly:false  → GATED (browser_action, feature 17
 *   browser_type       readOnly:false    decision table: require_approval
 *   browser_press_key  readOnly:false    always)
 *
 * Not exposed v1: evaluate/JS (code_exec-adjacent), uploads, downloads, tabs,
 * screenshots. All six tools are returnsExternalContent — page content taints
 * the run UNCONDITIONALLY (not only on injection-scanner matches), so later
 * side-effecting actions escalate and always-allow grants stop applying.
 *
 * Degrade, never crash: a dead/unspawnable MCP server returns a structured
 * { ok:false, error:"browser unavailable: …" } result (web_search pattern).
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { McpToolClient } from "../../mcp/playwrightMcp.js";

/** Hard cap on text returned to the loop — page AX trees can be huge and
 * observations are checkpointed to SQLite. */
export const BROWSER_TEXT_CAP = 16_000;

function capText(text: string): string {
  if (text.length <= BROWSER_TEXT_CAP) return text;
  return `${text.slice(0, BROWSER_TEXT_CAP)}\n[truncated ${text.length - BROWSER_TEXT_CAP} chars]`;
}

/**
 * Run one MCP browser tool call and map it to the structured tool result
 * shape. MCP-level errors (isError) and transport/spawn failures both come
 * back as ok:false — the agent reflects and retries or reports, never crashes.
 */
async function callBrowser(
  client: McpToolClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const result = await client.callTool(name, args);
    if (result.isError) {
      return { ok: false, error: capText(result.text) || "browser tool error" };
    }
    return { ok: true, text: capText(result.text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: capText(`browser unavailable: ${message}`) };
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const NavigateSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "only http(s) URLs are allowed")
    .describe("Absolute http(s) URL to open"),
});

const EmptySchema = z.object({});

const ClickSchema = z.object({
  element: z.string().min(1).describe("Human-readable element description"),
  ref: z.string().min(1).describe("Exact element ref from the latest browser_snapshot"),
});

const TypeSchema = z.object({
  element: z.string().min(1).describe("Human-readable element description"),
  ref: z.string().min(1).describe("Exact element ref from the latest browser_snapshot"),
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
});

const PressKeySchema = z.object({
  key: z.string().min(1).describe("Key to press, e.g. 'Enter', 'ArrowDown'"),
});

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build the six curated browser tools over an injected MCP client and
 * register their feature-17 risk metadata.
 */
export function makeBrowserTools(client: McpToolClient): Tool[] {
  const tools: Tool[] = [
    {
      name: "browser_navigate",
      description:
        "Open a URL in the headless browser (isolated profile, no logins). " +
        "Follow with browser_snapshot to read the page.",
      schema: NavigateSchema,
      readOnly: true,
      returnsExternalContent: true,
      run: async (args: unknown) => {
        const { url } = NavigateSchema.parse(args);
        return callBrowser(client, "browser_navigate", { url });
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Accessibility snapshot of the current page — the readable text plus " +
        "element refs used by browser_click/browser_type.",
      schema: EmptySchema,
      readOnly: true,
      returnsExternalContent: true,
      run: async (args: unknown) => {
        EmptySchema.parse(args ?? {});
        return callBrowser(client, "browser_snapshot", {});
      },
    },
    {
      name: "browser_go_back",
      description: "Go back to the previous page in the headless browser.",
      schema: EmptySchema,
      readOnly: true,
      returnsExternalContent: true,
      run: async (args: unknown) => {
        EmptySchema.parse(args ?? {});
        return callBrowser(client, "browser_navigate_back", {});
      },
    },
    {
      name: "browser_click",
      description:
        "Click an element on the current page (requires approval). Use the " +
        "ref from the latest browser_snapshot.",
      schema: ClickSchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (args: unknown) => {
        const parsed = ClickSchema.parse(args);
        // @playwright/mcp expects the snapshot ref under "target".
        return callBrowser(client, "browser_click", {
          element: parsed.element,
          target: parsed.ref,
        });
      },
    },
    {
      name: "browser_type",
      description:
        "Type text into an element on the current page (requires approval). " +
        "Never enter credentials or payment details.",
      schema: TypeSchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (args: unknown) => {
        const parsed = TypeSchema.parse(args);
        // @playwright/mcp expects the snapshot ref under "target".
        const mcpArgs: Record<string, unknown> = {
          element: parsed.element,
          target: parsed.ref,
          text: parsed.text,
        };
        if (parsed.submit !== undefined) mcpArgs["submit"] = parsed.submit;
        return callBrowser(client, "browser_type", mcpArgs);
      },
    },
    {
      name: "browser_press_key",
      description: "Press a keyboard key in the browser (requires approval).",
      schema: PressKeySchema,
      readOnly: false,
      returnsExternalContent: true,
      run: async (args: unknown) => {
        const parsed = PressKeySchema.parse(args);
        return callBrowser(client, "browser_press_key", parsed);
      },
    },
  ];

  // Feature 17 risk metadata. Interactions ride the LOCKED decision-table
  // class browser_action (require_approval, always) — do not weaken.
  registerToolMeta("browser_navigate", { sideEffects: "read_only", reversible: true });
  registerToolMeta("browser_snapshot", { sideEffects: "read_only", reversible: true });
  registerToolMeta("browser_go_back", { sideEffects: "read_only", reversible: true });
  registerToolMeta("browser_click", { sideEffects: "browser_action", reversible: false });
  registerToolMeta("browser_type", { sideEffects: "browser_action", reversible: false });
  registerToolMeta("browser_press_key", { sideEffects: "browser_action", reversible: false });

  return tools;
}
