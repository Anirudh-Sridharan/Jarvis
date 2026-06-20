/**
 * Work page — feature 13.
 * GitHub activity + Gmail email volume charts + interactive TODO list.
 */

import type { WidgetEnvelope, MetricSeriesContract, TodoContract, KpiValue } from "@/app/lib/contracts";
import MetricChart from "@/app/components/MetricChart";
import KpiCard from "@/app/components/KpiCard";
import TodoList from "@/app/components/TodoList";
import { EmptyState, ErrorState } from "@/app/components/WidgetStates";

import { fetchEnvelope } from "@/app/lib/fetchEnvelope";

function fetchSeries(metric: string, range = "30d"): Promise<WidgetEnvelope<MetricSeriesContract>> {
  return fetchEnvelope<MetricSeriesContract>(
    `/api/metrics?metric=${encodeURIComponent(metric)}&range=${range}&domain=work`,
  );
}

function fetchTodos(): Promise<WidgetEnvelope<TodoContract[]>> {
  return fetchEnvelope<TodoContract[]>("/api/todos?status=open");
}

function ChartSection({
  envelope,
  label,
  emptyMessage,
  ctaLabel,
  color,
}: {
  envelope: WidgetEnvelope<MetricSeriesContract>;
  label: string;
  emptyMessage: string;
  ctaLabel: string;
  color: string;
}) {
  if (envelope.state === "error") {
    return <ErrorState title={label} message={envelope.error?.message} />;
  }
  if (envelope.state === "empty" || !envelope.data) {
    return (
      <EmptyState
        title={label}
        message={emptyMessage}
        ctaLabel={ctaLabel}
        ctaHref="/settings/integrations"
      />
    );
  }
  return (
    <div className="card">
      <MetricChart
        points={envelope.data.points}
        label={label}
        unit={envelope.data.unit}
        kind="bar"
        color={color}
        downsampled={envelope.data.downsampled}
      />
    </div>
  );
}

export default async function WorkPage() {
  const [commitsEnv, prsEnv, receivedEnv, sentEnv, unreadEnv, todosEnv] = await Promise.all([
    fetchSeries("github.commits"),
    fetchSeries("github.prs_merged"),
    fetchSeries("gmail.received"),
    fetchSeries("gmail.sent"),
    fetchSeries("gmail.unread_count", "7d"),
    fetchTodos(),
  ]);

  const unreadLatest = unreadEnv.data?.points?.at(-1)?.value ?? null;
  const unreadKpi: KpiValue = {
    metricId: "gmail.unread_count",
    label: "Unread emails",
    value: unreadLatest,
    unit: "count",
    asOf: unreadEnv.data?.asOf ?? new Date().toISOString(),
    stale: unreadEnv.data?.stale ?? false,
    sourceConnected: unreadEnv.state !== "empty",
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">Operations</div>
        <h1 className="page-title">Work telemetry</h1>
        <p className="text-dim text-sm">GitHub + Gmail activity (30d) &middot; directives</p>
      </div>

      <div className="kpi-row">
        <KpiCard kpi={unreadKpi} />
      </div>

      <div className="work-grid">
        <div className="work-grid__charts">
          <ChartSection
            envelope={commitsEnv}
            label="Daily Commits"
            emptyMessage="No GitHub activity yet."
            ctaLabel="Connect GitHub"
            color="#38c6ff"
          />
          <ChartSection
            envelope={prsEnv}
            label="PRs Merged"
            emptyMessage="No pull request data yet."
            ctaLabel="Connect GitHub"
            color="#7fdcff"
          />
          <ChartSection
            envelope={receivedEnv}
            label="Emails Received"
            emptyMessage="No Gmail data yet."
            ctaLabel="Connect Gmail"
            color="#9fe8ff"
          />
          <ChartSection
            envelope={sentEnv}
            label="Emails Sent"
            emptyMessage="No Gmail data yet."
            ctaLabel="Connect Gmail"
            color="#1e9fd6"
          />
        </div>

        {/* Todos */}
        <div className="work-grid__todos">
          <TodoList initialEnvelope={todosEnv} />
        </div>
      </div>
    </div>
  );
}
