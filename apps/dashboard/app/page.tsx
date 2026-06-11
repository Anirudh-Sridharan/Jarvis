/**
 * Home overview — feature 14, "command center" layout.
 * Server Component that fetches KPIs, briefing, agenda, and todos in parallel:
 * KPI band up top for the 10-second morning scan, then briefing | agenda | todos,
 * with a slim chat-console strip below.
 */

import type { WidgetEnvelope, KpiValue, BriefingContract, AgendaEvent, TodoContract } from "@/app/lib/contracts";
import { isOverdue, localDateStr } from "@/app/lib/dates";
import BriefingCard from "./components/BriefingCard";
import AgendaList from "./components/AgendaList";
import KpiCard from "./components/KpiCard";
import TodoList from "./components/TodoList";
import VoiceHud from "./components/VoiceHud";

import { APP_BASE_URL as BASE } from "@/app/lib/clientEnv";

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

function greetingForHour(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage() {
  const today = localDateStr();

  // Parallel fetches — per-widget Suspense boundaries not needed here
  // because we gracefully handle error state inline
  const [sleepEnv, recoveryEnv, briefingEnv, agendaEnv, todosEnv, financeEnv] = await Promise.all([
    fetchJson<import("@/app/lib/contracts").MetricSeriesContract>(
      `/api/metrics?metric=sleep.duration_min&range=7d&domain=health`
    ),
    fetchJson<import("@/app/lib/contracts").MetricSeriesContract>(
      `/api/metrics?metric=recovery&range=7d&domain=health`
    ),
    fetchJson<BriefingContract>(`/api/briefing?date=${today}`),
    fetchJson<AgendaEvent[]>(`/api/agenda?date=${today}`),
    fetchJson<TodoContract[]>("/api/todos?status=open"),
    fetchJson<import("@/app/lib/contracts").FinanceOverviewContract>("/api/finance"),
  ]);

  // Derive KPI values from the latest point in each series
  const sleepLatest = sleepEnv.data?.points?.at(-1) ?? null;
  const recoveryLatest = recoveryEnv.data?.points?.at(-1) ?? null;
  const agendaCount = agendaEnv.data?.length ?? null;
  const todosOpen = todosEnv.data?.length ?? null;
  const todosOverdue = todosEnv.data?.filter(
    (t) => t.due && isOverdue(t.due)
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

  // Net worth KPI (first currency) once finance has synced accounts
  const primaryNetWorth = financeEnv.data?.netWorth[0];
  if (primaryNetWorth) {
    kpis.push(
      buildKpi(
        "Net worth",
        "finance.net_worth",
        primaryNetWorth.amountMinor / 100,
        primaryNetWorth.currency,
        new Date().toISOString(),
        false,
        true
      )
    );
  }

  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="page-home">
      <div className="page-header">
        <h1 className="page-title">{greetingForHour(now.getHours())}</h1>
        <p className="page-subtitle">{dateLabel}</p>
      </div>

      <VoiceHud />

      {/* KPI band */}
      <div className="kpi-row">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.metricId} kpi={kpi} />
        ))}
      </div>

      {/* Command-center grid: briefing | agenda | todos */}
      <div className="home-grid">
        <div className="home-grid__briefing">
          <BriefingCard envelope={briefingEnv} />
        </div>
        <div className="home-grid__agenda">
          <AgendaList envelope={agendaEnv} compact />
        </div>
        <div className="home-grid__todos">
          <TodoList initialEnvelope={todosEnv} />
        </div>
      </div>

      {/* Chat console strip */}
      <a href="/chat" className="chat-strip">
        <span className="chat-strip__prompt">▸ Ask Jarvis</span>
        <span>Open chat console →</span>
      </a>
    </div>
  );
}
