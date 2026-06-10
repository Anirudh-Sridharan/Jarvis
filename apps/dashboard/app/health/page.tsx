/**
 * Health page — feature 10.
 * Sleep / HRV / RHR / Recovery charts from MetricStore.
 */

import type { WidgetEnvelope, MetricSeriesContract } from "@/app/lib/contracts";
import MetricChart from "@/app/components/MetricChart";
import { EmptyState, ErrorState } from "@/app/components/WidgetStates";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

async function fetchSeries(metric: string, range = "30d"): Promise<WidgetEnvelope<MetricSeriesContract>> {
  try {
    const res = await fetch(
      `${BASE}/api/metrics?metric=${encodeURIComponent(metric)}&range=${range}&domain=health`,
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

function MetricSection({
  envelope,
  label,
  kind = "line",
  color,
}: {
  envelope: WidgetEnvelope<MetricSeriesContract>;
  label: string;
  kind?: "line" | "bar";
  color?: string;
}) {
  if (envelope.state === "error") {
    return <ErrorState title={label} message={envelope.error?.message} />;
  }
  if (envelope.state === "empty" || !envelope.data) {
    return (
      <EmptyState
        title={label}
        message="No data yet — connect a source to see this metric."
        ctaLabel="Connect sources"
        ctaHref="/settings/integrations"
      />
    );
  }

  const { points, unit, stale, downsampled } = envelope.data;

  return (
    <div className={`card${stale ? " card--stale" : ""}`}>
      {stale && (
        <div className="stale-banner">T+1 &middot; as of last night</div>
      )}
      <MetricChart
        points={points}
        label={label}
        unit={unit}
        kind={kind}
        color={color}
        downsampled={downsampled}
      />
    </div>
  );
}

export default async function HealthPage() {
  const [sleepEnv, hrvEnv, rhrEnv, recoveryEnv] = await Promise.all([
    fetchSeries("sleep.duration_min", "30d"),
    fetchSeries("hrv", "30d"),
    fetchSeries("rhr", "30d"),
    fetchSeries("recovery", "30d"),
  ]);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Health</h1>
        <p className="text-dim text-sm">30-day trends &middot; wearable data is T+1 (syncs overnight)</p>
      </div>

      <div className="chart-grid">
        <MetricSection envelope={sleepEnv} label="Sleep Duration" kind="bar" color="#5eead4" />
        <MetricSection envelope={recoveryEnv} label="Recovery Score" kind="line" color="#4ade80" />
        <MetricSection envelope={hrvEnv} label="HRV" kind="line" color="#a78bfa" />
        <MetricSection envelope={rhrEnv} label="Resting Heart Rate" kind="line" color="#fb923c" />
      </div>
    </div>
  );
}
