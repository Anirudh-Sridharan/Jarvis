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
import {
  makeEmailSearchTool,
  makeEmailGetTool,
  makeEmailSendTool,
  makeEmailDraftTool,
} from "./emailTools.js";
import { makeBrowserTools } from "./browserTools.js";
import type { McpToolClient } from "../../mcp/playwrightMcp.js";

export function buildToolRegistry(
  integrations: Pick<IntegrationsSystem, "calendar" | "todos" | "email">,
  /** Feature 18 browser slice: when provided, the six browser tools are added. */
  browser?: McpToolClient | null,
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
    makeWebSearchTool(),
    webFetchTool,
    // Email (live Gmail)
    makeEmailSearchTool(integrations),
    makeEmailGetTool(integrations),
    makeEmailSendTool(integrations),
    makeEmailDraftTool(integrations),
    // Browser (Playwright MCP) — only when a client is wired
    ...(browser ? makeBrowserTools(browser) : []),
  ];

  const registry: ToolRegistry = new Map(tools.map((t) => [t.name, t]));
  return registry;
}
