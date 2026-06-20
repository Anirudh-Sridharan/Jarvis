/**
 * Connector normalization helpers — the shared building blocks every connector
 * uses to turn a raw provider payload into canonical MetricPoints.
 *
 * Onboarding a new connector? You need exactly two things from this module:
 *
 *   - {@link ADAPTER_VERSION} — the single version string stamped on every point.
 *   - {@link metricPointFactory} — returns a `point({...})` builder that fills in
 *     the deterministic id, the batch ingest timestamp, and the adapter version,
 *     so a normalizer only specifies what actually varies (metric/value/unit/ts).
 *
 * This replaced the hand-written `points.push({ id: makeMetricId(...), source,
 * ..., ingestedAt, adapterVersion })` literal that was duplicated 20+ times.
 */

import type { MetricPoint, SourceId } from "../types.js";
import { makeMetricId } from "./metricStore.js";

/**
 * Adapter version stamped on every normalized MetricPoint.
 *
 * Bumping this string marks all previously-ingested points as produced by an
 * older adapter, so they can be re-processed. Centralized here so every
 * connector moves in lockstep — it was previously a separate `const
 * ADAPTER_VERSION = "1"` copied into each connector file.
 */
export const ADAPTER_VERSION = "1";

/** The fields a normalizer actually has to supply for one MetricPoint. */
export interface MetricPointInput {
  metric: string;
  value: number;
  unit: string;
  /** UTC ISO-8601 instant the value pertains to. */
  ts: string;
  /** Optional dimensions (e.g. `{ repo }`, `{ stage }`); defaults to `{}`. */
  dims?: Record<string, string>;
}

/**
 * Build a MetricPoint factory bound to a single source.
 *
 * The returned `point()` fills in the three fields that are identical for every
 * point a normalizer emits:
 *   - `id` — the deterministic hash from {@link makeMetricId}
 *   - `ingestedAt` — a single timestamp for the whole batch
 *   - `adapterVersion` — the shared {@link ADAPTER_VERSION}
 *
 * `ingestedAt` is captured once when the factory is created, so all points from
 * one normalization batch share one ingest timestamp — matching the previous
 * per-normalizer `const ingestedAt = new Date().toISOString()` idiom. Create the
 * factory at the point where you used to compute that timestamp (typically the
 * top of the normalizer).
 *
 * @param source      The connector's SourceId.
 * @param ingestedAt  Override the batch ingest timestamp (defaults to now).
 */
export function metricPointFactory(
  source: SourceId,
  ingestedAt: string = new Date().toISOString(),
): (input: MetricPointInput) => MetricPoint {
  return ({ metric, value, unit, ts, dims = {} }) => ({
    id: makeMetricId({ source, metric, ts, dims }),
    source,
    metric,
    value,
    unit,
    ts,
    dims,
    ingestedAt,
    adapterVersion: ADAPTER_VERSION,
  });
}
