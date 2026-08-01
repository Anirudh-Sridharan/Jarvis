/**
 * Tool registry assembler — builds the ToolRegistry Map from all real tool
 * implementations and wires them to the provided subsystems.
 *
 * Tool summary:
 *   Calendar (via @jarvis/integrations):
 *     calendar_find_time    readOnly:true
 *     calendar_create_event readOnly:false  → GATED (calendar_write) → live Google API
 *     calendar_move_event   readOnly:false  → GATED (calendar_write) → live Google API
 *
 *   Todos (via @jarvis/integrations):
 *     todo_add              readOnly:false  → auto_allow (internal_write)
 *     todo_list             readOnly:true
 *     todo_complete         readOnly:false  → auto_allow (internal_write)
 *
 *   Web Research:
 *     web_search            readOnly:true   (live Brave Search API — BRAVE_API_KEY)
 *     web_extract           readOnly:true   (Firecrawl /v2/scrape — FIRECRAWL_API_KEY)
 *     web_fetch             readOnly:true   (real fetch)
 *
 *   Email (live Gmail REST via @jarvis/integrations):
 *     email_search          readOnly:true
 *     email_get             readOnly:true
 *     email_send            readOnly:false  → GATED (outward_comm)
 *     email_draft           readOnly:false  → auto_allow (internal_write)
 *
 *   Browser (Playwright MCP, isolated headless profile — optional):
 *     browser_navigate      readOnly:true
 *     browser_snapshot      readOnly:true
 *     browser_go_back       readOnly:true
 *     browser_click         readOnly:false  → GATED (browser_action)
 *     browser_type          readOnly:false  → GATED (browser_action)
 *     browser_press_key     readOnly:false  → GATED (browser_action)
 *
 *   Mac control (Tier 1, phase 15 — optional, injected MacCommandRunner):
 *     mac_list_apps         readOnly:true
 *     mac_frontmost_app     readOnly:true
 *     mac_list_shortcuts    readOnly:true
 *     mac_open              readOnly:false  → GATED (mac_action)
 *     mac_run_script        readOnly:false  → GATED (mac_action)
 *     mac_run_shortcut      readOnly:false  → GATED (mac_action)
 *
 *   Mac control (Tier 2 — Accessibility, phase 15 — optional, same injected
 *   MacCommandRunner):
 *     mac_ui_snapshot       readOnly:true
 *     mac_ui_click          readOnly:false  → GATED (mac_action)
 *     mac_ui_type           readOnly:false  → GATED (mac_action)
 *     mac_ui_press_key      readOnly:false  → GATED (mac_action)
 */

import type { ToolRegistry } from "@jarvis/agent";
import type { IntegrationsSystem } from "@jarvis/integrations";
import {
  makeCalendarFindTimeTool,
  makeCalendarCreateEventTool,
  makeCalendarMoveEventTool,
} from "./calendarTools.js";
import {
  makeTodoAddTool,
  makeTodoListTool,
  makeTodoCompleteTool,
} from "./todoTools.js";
import { makeWebSearchTool, webFetchTool } from "./webResearchTools.js";
import { makeWebExtractTool } from "./webExtractTool.js";
import {
  makeEmailSearchTool,
  makeEmailGetTool,
  makeEmailSendTool,
  makeEmailDraftTool,
} from "./emailTools.js";
import { makeBrowserTools } from "./browserTools.js";
import type { McpToolClient } from "../../mcp/playwrightMcp.js";
import { makeMacTools } from "./macTools.js";
import { makeMacUiTools } from "./macUiTools.js";
import type { MacCommandRunner } from "../../mac/commandRunner.js";

export function buildToolRegistry(
  integrations: Pick<IntegrationsSystem, "calendar" | "todos" | "email">,
  /** Feature 18 browser slice: when provided, the six browser tools are added. */
  browser?: McpToolClient | null,
  /** Phase 15 Tier 1: when provided, the six Mac-control tools are added. */
  macRun?: MacCommandRunner | null,
): ToolRegistry {
  const tools = [
    // Calendar
    makeCalendarFindTimeTool(integrations),
    makeCalendarCreateEventTool(integrations),
    makeCalendarMoveEventTool(integrations),
    // Todos
    makeTodoAddTool(integrations),
    makeTodoListTool(integrations),
    makeTodoCompleteTool(integrations),
    // Web research
    makeWebExtractTool(),
    makeWebSearchTool(),
    webFetchTool,
    // Email (live Gmail)
    makeEmailSearchTool(integrations),
    makeEmailGetTool(integrations),
    makeEmailSendTool(integrations),
    makeEmailDraftTool(integrations),
    // Browser (Playwright MCP) — only when a client is wired
    ...(browser ? makeBrowserTools(browser) : []),
    // Mac control (Tier 1) — only when a command runner is wired
    ...(macRun ? makeMacTools(macRun) : []),
    // Mac control (Tier 2 — Accessibility) — only when a command runner is wired
    ...(macRun ? makeMacUiTools(macRun) : []),
  ];

  const registry: ToolRegistry = new Map(tools.map((t) => [t.name, t]));
  return registry;
}
