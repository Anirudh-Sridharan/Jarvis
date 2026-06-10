/**
 * Work page — feature 13.
 * GitHub activity chart + interactive TODO list.
 */

import type { WidgetEnvelope, MetricSeriesContract, TodoContract } from "@/app/lib/contracts";
import MetricChart from "@/app/components/MetricChart";
import TodoList from "@/app/components/TodoList";
import { EmptyState, ErrorState } from "@/app/components/WidgetStates";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

async function fetchSeries(metric: string): Promise<WidgetEnvelope<MetricSeriesContract>> {
  try {
    const res = await fetch(
      `${BASE}/api/metrics?metric=${encodeURIComponent(metric)}&range=30d&domain=work`,
      { cache: "no-store" }
    );
    return (await res.json()) as WidgetEnvelope<MetricSeriesContract>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

async function fetchTodos(): Promise<WidgetEnvelope<TodoContract[]>> {
  try {
    const res = await fetch(`${BASE}/api/todos?status=open`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<TodoContract[]>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

export default async function WorkPage() {
  const [commitsEnv, prsEnv, todosEnv] = await Promise.all([
    fetchSeries("commits"),
    fetchSeries("pr_merged"),
    fetchTodos(),
  ]);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Work</h1>
        <p className="text-dim text-sm">GitHub activity (30d) + todos</p>
      </div>

      <div className="work-grid">
        {/* GitHub activity charts */}
        <div className="work-grid__charts">
          {commitsEnv.state === "error" ? (
            <ErrorState title="Commits" message={commitsEnv.error?.message} />
          ) : commitsEnv.state === "empty" || !commitsEnv.data ? (
            <EmptyState
              title="Commits"
              message="No GitHub activity yet."
              ctaLabel="Connect GitHub"
              ctaHref="/settings/integrations"
            />
          ) : (
            <div className="card">
              <MetricChart
                points={commitsEnv.data.points}
                label="Daily Commits"
                unit={commitsEnv.data.unit}
                kind="bar"
                color="#5eead4"
                downsampled={commitsEnv.data.downsampled}
              />
            </div>
          )}

          {prsEnv.state === "error" ? (
            <ErrorState title="PRs Merged" message={prsEnv.error?.message} />
          ) : prsEnv.state === "empty" || !prsEnv.data ? (
            <EmptyState
              title="PRs Merged"
              message="No pull request data yet."
              ctaLabel="Connect GitHub"
              ctaHref="/settings/integrations"
            />
          ) : (
            <div className="card">
              <MetricChart
                points={prsEnv.data.points}
                label="PRs Merged"
                unit={prsEnv.data.unit}
                kind="bar"
                color="#4ade80"
                downsampled={prsEnv.data.downsampled}
              />
            </div>
          )}
        </div>

        {/* Todos */}
        <div className="work-grid__todos">
          <TodoList initialEnvelope={todosEnv} />
        </div>
      </div>
    </div>
  );
}
