/**
 * Calendar page — feature 12.
 * Today's agenda + upcoming events from CalendarMirror.
 */

import type { WidgetEnvelope, AgendaEvent } from "@/app/lib/contracts";
import { localDateStr } from "@/app/lib/dates";
import AgendaList from "@/app/components/AgendaList";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

async function fetchAgenda(date: string): Promise<WidgetEnvelope<AgendaEvent[]>> {
  try {
    const res = await fetch(`${BASE}/api/agenda?date=${date}`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<AgendaEvent[]>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

export default async function CalendarPage() {
  const today = localDateStr();

  // Fetch today + tomorrow (local calendar days)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = localDateStr(tomorrow);

  const [todayEnv, tomorrowEnv] = await Promise.all([
    fetchAgenda(today),
    fetchAgenda(tomorrowStr),
  ]);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Calendar</h1>
        <p className="text-dim text-sm">Agenda from your connected calendar</p>
      </div>

      <div className="agenda-sections">
        <section>
          <h2 className="section-title">Today</h2>
          <AgendaList envelope={todayEnv} />
        </section>
        <section>
          <h2 className="section-title">Tomorrow</h2>
          <AgendaList envelope={tomorrowEnv} />
        </section>
      </div>
    </div>
  );
}
