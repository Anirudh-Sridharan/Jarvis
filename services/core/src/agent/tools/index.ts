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
 *   Web Research (no external dep):
 *     web_search            readOnly:true   (stub — TODO(prod: wire real search API/MCP))
 *     web_fetch             readOnly:true   (real fetch)
 *
 *   Email (live Gmail REST via @jarvis/integrations):
 *     email_search          readOnly:true
 *     email_get             readOnly:true
 *     email_send            readOnly:false  → GATED (outward_comm)
 *     email_draft           readOnly:false  → auto_allow (internal_write)
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
import { webSearchTool, webFetchTool } from "./webResearchTools.js";
import {
  makeEmailSearchTool,
  makeEmailGetTool,
  makeEmailSendTool,
  makeEmailDraftTool,
} from "./emailTools.js";

export function buildToolRegistry(
  integrations: Pick<IntegrationsSystem, "calendar" | "todos" | "email">,
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
    webSearchTool,
    webFetchTool,
    // Email (live Gmail)
    makeEmailSearchTool(integrations),
    makeEmailGetTool(integrations),
    makeEmailSendTool(integrations),
    makeEmailDraftTool(integrations),
  ];

  const registry: ToolRegistry = new Map(tools.map((t) => [t.name, t]));
  return registry;
}
