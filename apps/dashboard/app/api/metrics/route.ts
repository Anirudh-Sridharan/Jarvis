/**
 * GET /api/metrics?metric=<id>&range=7d|30d|90d&domain=health|work|...
 *
 * Queries a MetricSeries from the local SQLite store.
 * Returns WidgetEnvelope<MetricSeriesContract>.
 * Never throws 500 on empty/missing data — returns state:"empty" instead.
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, MetricSeriesContract } from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";

function rangeParams(range: string): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  const days = range === "90d" ? 90 : range === "7d" ? 7 : 30;
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  return { from, to };
}

const STALE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const { searchParams } = req.nextUrl;
  const metric = searchParams.get("metric") ?? "";
  const range = searchParams.get("range") ?? "30d";
  const domain = (searchParams.get("domain") ?? "health") as MetricSeriesContract["domain"];

  if (!metric) {
    const envelope: WidgetEnvelope<MetricSeriesContract> = {
      data: null,
      state: "error",
      error: { code: "MISSING_PARAM", message: "metric query param required" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
    return NextResponse.json(envelope, { status: 400 });
  }

  try {
    const { metrics } = getIntegrations();
    const { from, to } = rangeParams(range);
    const series = metrics.querySeries(metric, { from, to }, { fn: "avg", bucket: "1d" });

    const points = series.points.map((p) => ({ ts: p.ts, value: p.value }));
    const latest = metrics.latest(metric);
    const asOf = latest?.ts ?? (points[points.length - 1]?.ts ?? new Date().toISOString());
    const stale = !latest || (Date.now() - new Date(latest.ts).getTime()) > STALE_MAX_AGE_MS;

    const data: MetricSeriesContract = {
      metricId: metric,
      domain,
      unit: series.unit || "",
      points,
      source: latest?.source ?? "none",
      asOf,
      stale,
      downsampled: points.length > 500,
    };

    const state = points.length === 0 ? "empty" : stale ? "stale" : "ok";
    const envelope: WidgetEnvelope<MetricSeriesContract> = {
      data: points.length === 0 ? null : data,
      state,
      meta: { source: latest?.source ?? "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<MetricSeriesContract> = {
      data: null,
      state: "error",
      error: { code: "STORE_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
