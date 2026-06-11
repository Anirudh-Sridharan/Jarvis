/**
 * Calendar agenda block for chat (feature 2 ↔ feature 12 bridge).
 *
 * "What's on my calendar?" cannot be answered reliably by top-k semantic
 * retrieval — enumerating a day's events is a deterministic lookup, not a
 * similarity search. When the user's message looks calendar-shaped, ChatCore
 * injects a compact agenda rendered straight from the local Google Calendar
 * mirror (the connected-app source of truth), in LOCAL time.
 *
 * The mirror access is behind the AgendaSource seam so tests inject a fake and
 * the chat core never reaches the integrations store directly.
 */

import type { CalendarEvent, CalendarMirror } from "@jarvis/integrations";

/** Injected into ChatCore; core wires the live calendar mirror behind it. */
export interface AgendaSource {
  /** Render a compact agenda block for the prompt, or "" when unavailable. */
  getAgendaBlock(now: Date): string;
}

/**
 * Cheap calendar-intent gate: the agenda block costs tokens every turn, so it
 * is only injected when the message plausibly asks about schedule/time.
 */
export const CALENDAR_INTENT =
  /\b(calendar|schedule|scheduled|agenda|meeting|meetings|event|events|appointment|appointments|busy|free|today|tonight|tomorrow|this week|next week|weekend|gcal)\b/i;

const DEFAULT_WINDOW_DAYS = 7;
const MAX_EVENTS = 20;

const localTz = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function localDay(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function renderEvent(e: CalendarEvent): string {
  if (e.allDay || !e.start.dateTime) {
    const day = e.start.date ?? e.start.dateTime?.slice(0, 10) ?? "?";
    return `- ${day} (all day): ${e.summary || "(untitled)"}`;
  }
  const day = localDay(new Date(e.start.dateTime));
  const from = localTime(e.start.dateTime);
  const to = e.end.dateTime ? `–${localTime(e.end.dateTime)}` : "";
  const loc = e.location ? ` @ ${e.location}` : "";
  return `- ${day} ${from}${to}: ${e.summary || "(untitled)"}${loc}`;
}

/**
 * Build the agenda block from the calendar mirror: events whose start falls in
 * [local midnight today, now + windowDays]. Empty windows still emit an
 * explicit "no events" line — silence would invite the model to invent one.
 */
export function buildAgendaBlock(
  mirror: Pick<CalendarMirror, "getEvents">,
  now: Date,
  windowDays = DEFAULT_WINDOW_DAYS,
): string {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0); // local midnight — today's earlier events still show
  const to = new Date(now.getTime() + windowDays * 86_400_000);

  const events = mirror
    .getEvents("primary", from.toISOString(), to.toISOString())
    .filter((e) => e.status !== "cancelled");

  const header = `## Calendar (Google Calendar, next ${windowDays} days, times in ${localTz()})`;
  if (events.length === 0) {
    return `${header}\nNo events in this window.`;
  }

  const shown = events.slice(0, MAX_EVENTS);
  const lines = shown.map(renderEvent);
  if (events.length > shown.length) {
    lines.push(`(+${events.length - shown.length} more events in this window)`);
  }
  lines.push("These are ALL the events in this window — do not invent others.");
  return `${header}\n${lines.join("\n")}`;
}
