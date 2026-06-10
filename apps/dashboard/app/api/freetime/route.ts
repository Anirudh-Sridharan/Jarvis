/**
 * GET /api/freetime?date=YYYY-MM-DD&duration=30 — free slots in the local day
 * (work hours), from the CalendarMirror via findFreeTime.
 * Returns WidgetEnvelope<FreeSlotContract[]>.
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, FreeSlotContract } from "@/app/lib/contracts";
import { localDateStr, localDayBounds } from "@/app/lib/dates";
import { getIntegrations } from "@/app/lib/services";

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const requested = req.nextUrl.searchParams.get("date");
  const date =
    requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : localDateStr();
  const durationParam = Number(req.nextUrl.searchParams.get("duration"));
  const durationMin =
    Number.isFinite(durationParam) && durationParam > 0 ? durationParam : 30;

  try {
    const { calendar } = getIntegrations();
    const { dayStart, dayEnd } = localDayBounds(date);
    const events = calendar.mirror
      .getEvents("primary", dayStart, dayEnd)
      .filter((e) => e.status !== "cancelled");

    // findFreeTime clamps work hours in UTC — pass a window already bounded
    // to LOCAL work hours (and to now, so past slots don't show) and disable
    // the UTC clamp instead.
    const workStart = new Date(`${date}T09:00:00`); // local time
    const workEnd = new Date(`${date}T18:00:00`);
    const windowStart = new Date(Math.max(workStart.getTime(), Date.now()));
    if (windowStart >= workEnd) {
      const envelope: WidgetEnvelope<FreeSlotContract[]> = {
        data: [],
        state: "empty",
        meta: { source: "gcal-mirror", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
      };
      return NextResponse.json(envelope);
    }

    const slots: FreeSlotContract[] = calendar
      .findFreeTime(windowStart.toISOString(), workEnd.toISOString(), durationMin, events, {
        workHoursStart: 0,
        workHoursEnd: 23,
      })
      .filter((s) => s.state === "free")
      .map((s) => ({
        start: s.start,
        end: s.end,
        durationMin: Math.round((Date.parse(s.end) - Date.parse(s.start)) / 60_000),
      }));

    const envelope: WidgetEnvelope<FreeSlotContract[]> = {
      data: slots,
      state: slots.length === 0 ? "empty" : "ok",
      meta: { source: "gcal-mirror", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<FreeSlotContract[]> = {
      data: null,
      state: "error",
      error: { code: "STORE_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
