/**
 * GET /api/agenda?date=YYYY-MM-DD  — today/upcoming calendar events
 *
 * Reads from the local CalendarMirror SQLite store.
 * Returns WidgetEnvelope<AgendaEvent[]>.
 * Never 500 on empty — returns state:"empty".
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, AgendaEvent } from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";
import type { CalendarEvent } from "@jarvis/integrations";

function toContract(e: CalendarEvent): AgendaEvent {
  const startStr = e.start.dateTime
    ? new Date(e.start.dateTime).toISOString().slice(11, 16)
    : e.start.date ?? "";
  const endStr = e.end.dateTime
    ? new Date(e.end.dateTime).toISOString().slice(11, 16)
    : e.end.date ?? "";

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
  const date = req.nextUrl.searchParams.get("date") ?? todayDate();
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;

  try {
    const { calendar } = getIntegrations();
    const events = calendar.mirror.getEvents("primary", dayStart, dayEnd);
    const contracts = events
      .filter((e) => e.status !== "cancelled")
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

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
