/**
 * GET /api/agenda?date=YYYY-MM-DD  — today/upcoming calendar events
 *
 * Reads from the local CalendarMirror SQLite store.
 * Returns WidgetEnvelope<AgendaEvent[]>.
 * Never 500 on empty — returns state:"empty".
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, AgendaEvent } from "@/app/lib/contracts";
import { localDateStr, localDayBounds } from "@/app/lib/dates";
import { getIntegrations } from "@/app/lib/services";
import type { CalendarEvent } from "@jarvis/integrations";

/** HH:MM in the machine's local timezone (NOT UTC — toISOString would shift it). */
function localTime(dateTime: string): string {
  return new Date(dateTime).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function toContract(e: CalendarEvent): AgendaEvent {
  const startStr = e.start.dateTime ? localTime(e.start.dateTime) : e.start.date ?? "";
  const endStr = e.end.dateTime ? localTime(e.end.dateTime) : e.end.date ?? "";

  return {
    id: e.id,
    summary: e.summary,
    start: startStr,
    end: endStr,
    allDay: e.allDay,
    location: e.location,
  };
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  // Day window = the LOCAL day, not the UTC day — otherwise evening events
  // land on the wrong date for anyone west/east of UTC.
  const requested = req.nextUrl.searchParams.get("date");
  const date =
    requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : localDateStr();
  const { dayStart, dayEnd } = localDayBounds(date);

  try {
    const { calendar } = getIntegrations();
    const events = calendar.mirror.getEvents("primary", dayStart, dayEnd);
    const contracts = events
      .filter((e) => e.status !== "cancelled")
      // The mirror matches all-day events by date-prefix of the bounds, which
      // can spill a day past the local window — keep only the requested day.
      .filter((e) => !e.allDay || e.start.date === date)
      .map(toContract);

    const envelope: WidgetEnvelope<AgendaEvent[]> = {
      data: contracts,
      state: contracts.length === 0 ? "empty" : "ok",
      meta: { source: "gcal-mirror", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const isDataMissing =
      err instanceof Error &&
      (err.message.includes("no such table") || err.message.includes("SQLITE_ERROR"));

    const envelope: WidgetEnvelope<AgendaEvent[]> = {
      data: null,
      state: isDataMissing ? "empty" : "error",
      error: isDataMissing
        ? undefined
        : { code: "CALENDAR_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
