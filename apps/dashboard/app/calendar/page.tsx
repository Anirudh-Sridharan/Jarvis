/**
 * Calendar page — feature 12.
 * Today's agenda + upcoming events from CalendarMirror.
 */

import type { WidgetEnvelope, AgendaEvent, FreeSlotContract } from "@/app/lib/contracts";
import { localDateStr } from "@/app/lib/dates";
import AgendaList from "@/app/components/AgendaList";
import { fetchEnvelope as fetchJson } from "@/app/lib/fetchEnvelope";

const fetchAgenda = (date: string) => fetchJson<AgendaEvent[]>(`/api/agenda?date=${date}`);

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function FreeTimeCard({ envelope }: { envelope: WidgetEnvelope<FreeSlotContract[]> }) {
  if (envelope.state === "error") return null;
  const slots = envelope.data ?? [];
  return (
    <div className="card">
      <div className="card__title">Free Time Today</div>
      {slots.length === 0 ? (
        <p className="text-dim">No free slots left in work hours.</p>
      ) : (
        <ul className="freeslot-list">
          {slots.map((s) => (
            <li key={s.start} className="freeslot-list__item">
              <span className="freeslot-list__range">
                {localTime(s.start)} – {localTime(s.end)}
              </span>
              <span className="text-dim text-sm">{s.durationMin} min</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function CalendarPage() {
  const today = localDateStr();

  // Fetch today + tomorrow (local calendar days)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = localDateStr(tomorrow);

  const [todayEnv, tomorrowEnv, freeEnv] = await Promise.all([
    fetchAgenda(today),
    fetchAgenda(tomorrowStr),
    fetchJson<FreeSlotContract[]>(`/api/freetime?date=${today}&duration=30`),
  ]);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">Schedule</div>
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
        <section>
          <h2 className="section-title">Open Slots</h2>
          <FreeTimeCard envelope={freeEnv} />
        </section>
      </div>
    </div>
  );
}
