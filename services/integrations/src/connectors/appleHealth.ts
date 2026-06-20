/**
 * Apple Health connector — PUSH model (no OAuth).
 *
 * The iOS "Health Auto Export" app POSTs batched JSON to a local endpoint.
 * This module provides:
 *   1. ingest(body) — normalizes Health Auto Export JSON → MetricPoints (idempotent)
 *   2. createPushEndpointHandler(store, secret) — HTTP handler factory for the push endpoint
 *
 * The connector sync() method is a no-op (push-only source).
 * Idempotency: each point is keyed by (source, metric, ts) which maps to a
 * deterministic MetricPoint.id via makeMetricId.
 */

import type {
  Connector,
  ConnectorSyncResult,
  Cursor,
  HttpClient,
  MetricPoint,
  TokenStore,
} from "../types.js";
import { metricPointFactory } from "../framework/normalize.js";

// Connector stub (push-only: sync is a no-op)
export const appleHealthConnector: Connector = {
  id: "apple_health",
  auth: "push",
  schedule: "0 0 * * *", // never auto-scheduled (push-triggered)
  concurrency: 1,

  // Push-only: sync always returns empty (data arrives via ingest())
  async sync(
    _cursor: Cursor | null,
    _http: HttpClient,
    _tokenStore: TokenStore
  ): Promise<ConnectorSyncResult> {
    return { points: [], nextCursor: null };
  },
};

// ── Health Auto Export JSON shapes ────────────────────────────────────────────

interface HAEMetricSample {
  date?: string;
  qty?: number;
  value?: number;
  units?: string;
  startDate?: string;
  endDate?: string;
}

interface HAEMetric {
  name?: string;
  units?: string;
  data?: HAEMetricSample[];
}

interface HAEWorkout {
  workoutActivityType?: string;
  duration?: number;
  totalEnergyBurned?: number;
  startDate?: string;
  endDate?: string;
}

interface HAEBody {
  data?: {
    metrics?: HAEMetric[];
    workouts?: HAEWorkout[];
  };
}

// Canonical metric name mapping from Health Auto Export metric names
const METRIC_MAP: Record<string, { metric: string; unit: string }> = {
  "heart_rate_variability_sdnn": { metric: "hrv", unit: "ms" },
  "heart_rate": { metric: "heartRate", unit: "bpm" },
  "resting_heart_rate": { metric: "restingHr", unit: "bpm" },
  "step_count": { metric: "steps", unit: "count" },
  "active_energy_burned": { metric: "activeEnergy", unit: "kcal" },
  "body_mass": { metric: "weight", unit: "kg" },
  "body_fat_percentage": { metric: "bodyFat", unit: "%" },
  "oxygen_saturation": { metric: "spo2", unit: "%" },
  "respiratory_rate": { metric: "respiratoryRate", unit: "breaths/min" },
  "sleep_analysis": { metric: "sleep.duration_min", unit: "min" },
  "apple_sleeping_wristtemperature": { metric: "wristTemp", unit: "C" },
  // Common name variants
  "heartratevariabilitysdnn": { metric: "hrv", unit: "ms" },
  "heartrate": { metric: "heartRate", unit: "bpm" },
  "restingheartrate": { metric: "restingHr", unit: "bpm" },
  "stepcount": { metric: "steps", unit: "count" },
  "activeenergyburned": { metric: "activeEnergy", unit: "kcal" },
  "bodymass": { metric: "weight", unit: "kg" },
  "bodyfatpercentage": { metric: "bodyFat", unit: "%" },
  "oxygensaturation": { metric: "spo2", unit: "%" },
  "respiratoryrate": { metric: "respiratoryRate", unit: "breaths/min" },
};

/** Convert a unit+value to canonical metric unit. */
function convertUnit(value: number, fromUnit: string | undefined, toUnit: string): number {
  if (!fromUnit) return value;
  const from = fromUnit.toLowerCase().trim();

  // Distance: miles → meters
  if (from === "mi" && toUnit === "m") return value * 1609.34;
  // Temperature: °F → °C
  if ((from === "°f" || from === "f") && toUnit === "C") return (value - 32) / 1.8;
  // Energy: kJ → kcal
  if (from === "kj" && toUnit === "kcal") return value / 4.184;

  return value; // already canonical
}

/**
 * Ingest a Health Auto Export JSON body and return normalized MetricPoints.
 * Idempotent: same data produces same MetricPoint ids → safe to re-POST.
 */
export function ingestAppleHealth(body: HAEBody): MetricPoint[] {
  const point = metricPointFactory("apple_health");
  const points: MetricPoint[] = [];

  for (const metric of body.data?.metrics ?? []) {
    const rawName = (metric.name ?? "").toLowerCase().replace(/[^a-z_]/g, "");
    const mapping = METRIC_MAP[metric.name ?? ""] ?? METRIC_MAP[rawName];

    if (!mapping) continue; // unknown metric, skip (no quarantine here — just skip)

    for (const sample of metric.data ?? []) {
      const rawValue = sample.qty ?? sample.value;
      if (rawValue == null) continue;

      const ts = sample.date ?? sample.startDate;
      if (!ts) continue;

      // Reject future timestamps (clock skew guard)
      if (new Date(ts).getTime() > Date.now() + 5 * 60_000) continue;

      const value = convertUnit(rawValue, sample.units ?? metric.units, mapping.unit);

      points.push(point({ metric: mapping.metric, value, unit: mapping.unit, ts }));
    }
  }

  return points;
}

/**
 * HTTP push-endpoint handler factory.
 * Returns an async function that handles incoming POST requests.
 *
 * @param onPoints  Callback to persist the normalized MetricPoints
 * @param secret    Bearer token secret (shared with the iOS app)
 */
export function createPushEndpointHandler(
  onPoints: (points: MetricPoint[]) => Promise<void> | void,
  secret: string
) {
  return async function handleAppleHealthPost(
    authHeader: string | undefined,
    body: unknown
  ): Promise<{ status: number; body: unknown }> {
    if (authHeader !== `Bearer ${secret}`) {
      return { status: 401, body: { error: "unauthorized" } };
    }

    const haeBody = body as HAEBody;
    if (!haeBody?.data) {
      return { status: 400, body: { error: "no data" } };
    }

    const points = ingestAppleHealth(haeBody);
    await onPoints(points);

    return { status: 200, body: { accepted: points.length } };
  };
}
