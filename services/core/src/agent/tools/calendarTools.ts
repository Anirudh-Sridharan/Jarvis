/**
 * Calendar tools — bridge @jarvis/agent Tool interface to @jarvis/integrations calendar.
 *
 * calendar_find_time    — read-only: find free slots in a window
 * calendar_create_event — write: gated by approval (readOnly:false)
 * calendar_move_event   — write: gated by approval (readOnly:false)
 *
 * Writes call integrations.calendar.executeWrite — the live Google Calendar
 * write engine bound to the injected HttpClient/TokenStore (feature 12 write
 * path). The approval gate fires in the agent ReAct loop BEFORE tool.run(),
 * so by the time executeWrite runs the action is user-approved (feature 17).
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { IntegrationsSystem } from "@jarvis/integrations";

// ── calendar_find_time ─────────────────────────────────────────────────────────

const FindTimeSchema = z.object({
  window_start: z.string().describe("ISO-8601 window start"),
  window_end: z.string().describe("ISO-8601 window end"),
  duration_minutes: z.number().int().positive().describe("Required slot length in minutes"),
  attendees: z.array(z.string().email()).optional().describe("Attendee emails to check"),
  timezone: z.string().optional().describe("IANA timezone"),
});

export function makeCalendarFindTimeTool(
  integrations: Pick<IntegrationsSystem, "calendar">,
): Tool {
  return {
    name: "calendar_find_time",
    description: "Find free time slots in a calendar window. Returns available slots.",
    schema: FindTimeSchema,
    readOnly: true,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = FindTimeSchema.parse(rawArgs);
      // Fetch events from the local mirror within the window
      const events = integrations.calendar.mirror.getEvents(
        "primary",
        args.window_start,
        args.window_end,
      );
      const slots = integrations.calendar.findFreeTime(
        args.window_start,
        args.window_end,
        args.duration_minutes,
        events,
      );
      return { slots, count: slots.length };
    },
  };
}

// ── calendar_create_event ─────────────────────────────────────────────────────

const CreateEventSchema = z.object({
  title: z.string().min(1).describe("Event title / summary"),
  start: z.string().describe("ISO-8601 start datetime"),
  end: z.string().describe("ISO-8601 end datetime"),
  attendees: z.array(z.string().email()).optional().describe("Attendee emails"),
  description: z.string().optional().describe("Optional event description"),
  location: z.string().optional().describe("Optional location"),
});

export function makeCalendarCreateEventTool(
  integrations: Pick<IntegrationsSystem, "calendar">,
): Tool {
  // Register as calendar_write — always requires approval per policy
  registerToolMeta("calendar_create_event", {
    sideEffects: "calendar_write",
    reversible: true,
  });

  return {
    name: "calendar_create_event",
    description:
      "Create a Google Calendar event. Requires approval (write operation). Returns the canonical created event, or conflicts if the slot is taken.",
    schema: CreateEventSchema,
    readOnly: false, // triggers approval gate in agent loop

    async run(rawArgs: unknown): Promise<unknown> {
      const args = CreateEventSchema.parse(rawArgs);
      return integrations.calendar.executeWrite({
        requestId: `agent-create-${Date.now()}`,
        op: "create",
        calendarId: "primary",
        patch: {
          summary: args.title,
          description: args.description,
          location: args.location,
          start: { dateTime: args.start, timeZone: "UTC" },
          end: { dateTime: args.end, timeZone: "UTC" },
          attendees: args.attendees?.map((email) => ({ email })),
        },
        reason: "Agent-created event (approved by user)",
      });
    },
  };
}

// ── calendar_move_event ───────────────────────────────────────────────────────

const MoveEventSchema = z.object({
  event_id: z.string().describe("Google Calendar event ID"),
  new_start: z.string().describe("New ISO-8601 start datetime"),
  new_end: z.string().describe("New ISO-8601 end datetime"),
  reason: z.string().optional().describe("Reason for moving the event"),
});

export function makeCalendarMoveEventTool(
  integrations: Pick<IntegrationsSystem, "calendar">,
): Tool {
  // Register as calendar_write — always requires approval per policy
  registerToolMeta("calendar_move_event", {
    sideEffects: "calendar_write",
    reversible: true,
  });

  return {
    name: "calendar_move_event",
    description:
      "Move/reschedule a Google Calendar event. Requires approval (write operation). Returns the canonical updated event, or conflicts if the new slot is taken.",
    schema: MoveEventSchema,
    readOnly: false, // triggers approval gate in agent loop

    async run(rawArgs: unknown): Promise<unknown> {
      const args = MoveEventSchema.parse(rawArgs);
      return integrations.calendar.executeWrite({
        requestId: `agent-move-${Date.now()}`,
        op: "update",
        calendarId: "primary",
        eventId: args.event_id,
        patch: {
          start: { dateTime: args.new_start, timeZone: "UTC" },
          end: { dateTime: args.new_end, timeZone: "UTC" },
        },
        reason: args.reason ?? "Agent-rescheduled event (approved by user)",
      });
    },
  };
}
