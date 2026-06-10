/**
 * Home overview — feature 14.
 * Server Component that fetches KPIs, briefing, and agenda in parallel,
 * then renders cards + a link to the full chat page.
 */

import type { WidgetEnvelope, KpiValue, BriefingContract, AgendaEvent, TodoContract } from "@/app/lib/contracts";
import BriefingCard from "./components/BriefingCard";
import AgendaList from "./components/AgendaList";
import KpiCard from "./components/KpiCard";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

async function fetchJson<T>(path: string): Promise<WidgetEnvelope<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<T>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

function buildKpi(
  label: string,
  metricId: string,
  value: number | null,
  unit: string,
  asOf: string,
  stale: boolean,
  sourceConnected: boolean
): KpiValue {
  return { metricId, label, value, unit, asOf, stale, sourceConnected };
}

export default async function HomePage() {
  const today = new Date().toISOString().slice(0, 10);

  // Parallel fetches — per-widget Suspense boundaries not needed here
  // because we gracefully handle error state inline
  const [sleepEnv, recoveryEnv, briefingEnv, agendaEnv, todosEnv] = await Promise.all([
    fetchJson<import("@/app/lib/contracts").MetricSeriesContract>(
      `/api/metrics?metric=sleep.duration_min&range=7d&domain=health`
    ),
    fetchJson<import("@/app/lib/contracts").MetricSeriesContract>(
      `/api/metrics?metric=recovery&range=7d&domain=health`
    ),
    fetchJson<BriefingContract>(`/api/briefing?date=${today}`),
    fetchJson<AgendaEvent[]>(`/api/agenda?date=${today}`),
    fetchJson<TodoContract[]>("/api/todos?status=open"),
  ]);

  // Derive KPI values from the latest point in each series
  const sleepLatest = sleepEnv.data?.points?.at(-1) ?? null;
  const recoveryLatest = recoveryEnv.data?.points?.at(-1) ?? null;
  const agendaCount = agendaEnv.data?.length ?? null;
  const todosOpen = todosEnv.data?.length ?? null;
  const todosOverdue = todosEnv.data?.filter(
    (t) => t.due && new Date(t.due) < new Date()
  ).length ?? 0;

  const kpis: KpiValue[] = [
    buildKpi(
      "Last night sleep",
      "sleep.duration_min",
      sleepLatest?.value ?? null,
      "min",
      sleepEnv.data?.asOf ?? new Date().toISOString(),
      sleepEnv.data?.stale ?? false,
      sleepEnv.state !== "empty"
    ),
    buildKpi(
      "Recovery",
      "recovery",
      recoveryLatest?.value ?? null,
      "%",
      recoveryEnv.data?.asOf ?? new Date().toISOString(),
      recoveryEnv.data?.stale ?? false,
      recoveryEnv.state !== "empty"
    ),
    buildKpi(
      "Today's agenda",
      "calendar.events",
      agendaCount,
      "count",
      new Date().toISOString(),
      false,
      agendaEnv.state !== "empty"
    ),
    buildKpi(
      "Todos open",
      "todos.open",
      todosOpen,
      "count",
      new Date().toISOString(),
      false,
      true
    ),
    {
      metricId: "todos.overdue",
      label: "Todos overdue",
      value: todosOverdue,
      unit: "count",
      asOf: new Date().toISOString(),
      stale: false,
      sourceConnected: true,
      trend: todosOverdue > 0 ? "down" : "flat",
    },
  ];

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="page-home">
      <div className="page-header">
        <h1 className="page-title">Good morning</h1>
        <p className="page-subtitle">{dateLabel}</p>
      </div>

      {/* KPI row */}
      <div className="kpi-row">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.metricId} kpi={kpi} />
        ))}
      </div>

      {/* Content grid */}
      <div className="home-grid">
        <div className="home-grid__briefing">
          <BriefingCard envelope={briefingEnv} />
        </div>
        <div className="home-grid__agenda">
          <AgendaList envelope={agendaEnv} compact />
        </div>
        <div className="home-grid__chat">
          <div className="card">
            <div className="card__title">Chat</div>
            <p className="text-dim">Ask Jarvis about your day, todos, or anything else.</p>
            <a href="/chat" className="link-cta">Open Chat</a>
          </div>
        </div>
      </div>
    </div>
  );
}
