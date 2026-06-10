import type { AgendaEvent, WidgetEnvelope } from "@/app/lib/contracts";

interface AgendaListProps {
  envelope: WidgetEnvelope<AgendaEvent[]>;
  compact?: boolean;
}

export default function AgendaList({ envelope, compact = false }: AgendaListProps) {
  if (envelope.state === "error") {
    return (
      <div className="card card--error">
        <div className="card__title">Agenda</div>
        <p className="text-error text-sm">{envelope.error?.message ?? "Failed to load agenda"}</p>
      </div>
    );
  }

  const events = envelope.data ?? [];

  if (events.length === 0) {
    return (
      <div className="card">
        <div className="card__title">Today&apos;s Agenda</div>
        <p className="text-dim">No events — open calendar for a free day.</p>
        <a href="/settings/integrations" className="link-cta">Connect Calendar</a>
      </div>
    );
  }

  return (
    <div className={`card${compact ? " card--compact" : ""}`}>
      {!compact && <div className="card__title">Today&apos;s Agenda</div>}
      <ul className="agenda-list">
        {events.slice(0, compact ? 5 : 20).map((e) => (
          <li key={e.id} className="agenda-list__item">
            <span className="agenda-list__time">{e.start}</span>
            <span className="agenda-list__title">{e.summary}</span>
            {e.allDay && <span className="badge-pill">all-day</span>}
          </li>
        ))}
      </ul>
      {events.length > 5 && compact && (
        <a href="/calendar" className="link-cta">See all {events.length} events</a>
      )}
    </div>
  );
}
