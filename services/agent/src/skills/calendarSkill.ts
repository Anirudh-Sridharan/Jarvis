/**
 * Calendar management skill (feature 18).
 *
 * Operations:
 *   - find-time: read-only free/busy query → no approval
 *   - schedule/move/delete: calendar_write → approval required
 *
 * Timezone-aware: all slots computed in user's primary TZ.
 */

import { z } from "zod";
import type { Skill, SkillCtx } from "./registry.js";
import { ToolApprovalDeniedError } from "./registry.js";
import type { SkillResult, SkillAction } from "../types.js";
import { registerToolMeta } from "../safety/policy.js";

// Register calendar write tools as requiring approval
registerToolMeta("calendar_create_event", {
  sideEffects: "calendar_write",
  reversible: true,
});
registerToolMeta("calendar_update_event", {
  sideEffects: "calendar_write",
  reversible: true,
});
registerToolMeta("calendar_delete_event", {
  sideEffects: "calendar_write",
  reversible: false,
});
registerToolMeta("calendar_list_events", {
  sideEffects: "read_only",
  reversible: true,
});
registerToolMeta("calendar_free_busy", {
  sideEffects: "read_only",
  reversible: true,
});

const CalendarArgs = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("find_time"),
    duration_minutes: z.number().int().min(5).max(480),
    window_start: z.string(), // ISO
    window_end: z.string(), // ISO
    attendees: z.array(z.string()).optional(),
    timezone: z.string().optional().default("UTC"),
  }),
  z.object({
    action: z.literal("schedule"),
    title: z.string().min(1),
    start: z.string(), // ISO
    end: z.string(), // ISO
    attendees: z.array(z.string()).optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    action: z.literal("move"),
    eventId: z.string(),
    new_start: z.string(),
    new_end: z.string(),
  }),
  z.object({
    action: z.literal("delete"),
    eventId: z.string(),
    reason: z.string().optional(),
  }),
]);

export const calendarSkill: Skill = {
  id: "calendar.manage",
  name: "Calendar Management",
  description:
    "Find available time, schedule, move, or delete calendar events.",
  allowedTools: [
    "calendar_list_events",
    "calendar_free_busy",
    "calendar_create_event",
    "calendar_update_event",
    "calendar_delete_event",
  ],
  outward: true,
  approvalPolicy: "conditional",

  async run(rawArgs: unknown, ctx: SkillCtx): Promise<SkillResult> {
    const parsed = CalendarArgs.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        skillId: "calendar.manage",
        status: "clarify",
        summary: "Invalid arguments for calendar skill",
        artifacts: [],
        actions: [],
        citations: [],
        clarifyQuestion: parsed.error.issues.map((i) => i.message).join("; "),
      };
    }

    const args = parsed.data;

    if (args.action === "find_time") {
      // Read-only, no approval
      let slots: unknown;
      try {
        slots = await ctx.tool("calendar_free_busy", {
          window_start: args.window_start,
          window_end: args.window_end,
          duration_minutes: args.duration_minutes,
          attendees: args.attendees ?? [],
          timezone: args.timezone,
        });
      } catch (err) {
        return {
          skillId: "calendar.manage",
          status: "error",
          summary: `Could not query free/busy: ${err instanceof Error ? err.message : String(err)}`,
          artifacts: [],
          actions: [],
          citations: [],
        };
      }

      return {
        skillId: "calendar.manage",
        status: "ok",
        summary: `Found available slots for ${args.duration_minutes} min meeting`,
        artifacts: Array.isArray(slots) ? slots : [slots],
        actions: [],
        citations: [],
      };
    }

    // Write operations → ctx.tool gates them structurally (calendar_write
    // risk class → require_approval; delete → double-confirm metadata).
    const toolName =
      args.action === "schedule"
        ? "calendar_create_event"
        : args.action === "move"
          ? "calendar_update_event"
          : "calendar_delete_event";

    let result: unknown;
    try {
      result = await ctx.tool(toolName, args, {
        reasoning: `Calendar ${args.action} requested`,
      });
    } catch (err) {
      if (err instanceof ToolApprovalDeniedError) {
        const actions: SkillAction[] = [
          {
            type: `calendar.${args.action}`,
            status: "skipped",
            reason:
              err.outcome === "blocked"
                ? "blocked"
                : err.outcome,
          },
        ];
        return {
          skillId: "calendar.manage",
          status: "skipped",
          summary:
            err.outcome === "blocked"
              ? `Calendar ${args.action} blocked: ${err.reasons.join("; ")}`
              : `Calendar ${args.action} not approved`,
          artifacts: [],
          actions,
          citations: [],
        };
      }
      return {
        skillId: "calendar.manage",
        status: "error",
        summary: `Calendar ${args.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        artifacts: [],
        actions: [
          {
            type: `calendar.${args.action}`,
            status: "failed",
            reason: err instanceof Error ? err.message : String(err),
          },
        ],
        citations: [],
      };
    }

    return {
      skillId: "calendar.manage",
      status: "ok",
      summary: `Calendar ${args.action} completed`,
      artifacts: [result],
      actions: [{ type: `calendar.${args.action}`, status: "done" }],
      citations: [],
    };
  },
};
