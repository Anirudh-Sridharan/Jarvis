/**
 * MetricStore — idempotent upsert + query for MetricPoint time series.
 *
 * Key design decisions:
 *  - Upsert is idempotent on MetricPoint.id (deterministic hash).
 *    Re-running any SyncRun or re-posting overlapping windows never duplicates.
 *  - Storage is raw resolution; downsampling happens at query time.
 *  - querySeries supports optional aggregation: avg/sum/min/max/last per bucket.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MetricPoint, MetricSeries } from "../types.js";
import { toJson, fromJson } from "../db/database.js";

export function makeMetricId(
  p: Pick<MetricPoint, "source" | "metric" | "ts" | "dims">
): string {
  const dims = Object.entries(p.dims ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHash("sha256")
    .update(`${p.source}|${p.metric}|${p.ts}|${dims}`)
    .digest("hex")
    .slice(0, 32);
}

export class MetricStore {
  constructor(private db: DatabaseSync) {}

  /**
   * Upsert MetricPoints idempotently.
   * Returns counts of inserted vs updated rows.
   */
  upsertSeries(points: MetricPoint[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;

    const upsert = this.db.prepare(`
      INSERT INTO metric_points
        (id, source, metric, value, unit, ts, dims, ingested_at, adapter_version)
      VALUES
        (:id, :source, :metric, :value, :unit, :ts, :dims, :ingested_at, :adapter_version)
      ON CONFLICT(id) DO UPDATE SET
        value           = excluded.value,
        ingested_at     = excluded.ingested_at,
        adapter_version = excluded.adapter_version
    `);

    const exists = this.db.prepare(
      "SELECT id FROM metric_points WHERE id = ?"
    );

    for (const p of points) {
      const id = p.id || makeMetricId(p);
      const pointWithId = { ...p, id };
      const existing = exists.get(id) as { id: string } | undefined;

      upsert.run({
        id,
        source: pointWithId.source,
        metric: pointWithId.metric,
        value: pointWithId.value,
        unit: pointWithId.unit,
        ts: pointWithId.ts,
        dims: toJson(pointWithId.dims ?? {}),
        ingested_at: pointWithId.ingestedAt,
        adapter_version: pointWithId.adapterVersion,
      });

      if (existing) {
        updated++;
      } else {
        inserted++;
      }
    }

    return { inserted, updated };
  }

  /**
   * Query a metric series with optional time-bucket aggregation.
   *
   * @param metric  The metric name (e.g. 'hrv', 'commits')
   * @param range   { from, to } UTC ISO strings (inclusive)
   * @param agg     Optional: { fn: 'avg'|'sum'|'min'|'max'|'last', bucket: '1h'|'1d'|'1w' }
   */
  querySeries(
    metric: string,
    range: { from: string; to: string },
    agg?: {
      fn: "sum" | "avg" | "min" | "max" | "last";
      bucket: "1h" | "1d" | "1w";
    } | null
  ): MetricSeries {
    if (!agg) {
      // Raw resolution
      const rows = this.db
        .prepare(
          `SELECT ts, value, dims FROM metric_points
           WHERE metric = ? AND ts >= ? AND ts <= ?
           ORDER BY ts ASC`
        )
        .all(metric, range.from, range.to) as Array<{
        ts: string;
        value: number;
        dims: string;
      }>;

      const unit = this.getUnit(metric);
      return {
        metric,
        unit,
        agg: null,
        points: rows.map((r) => ({
          ts: r.ts,
          value: r.value,
          dims: fromJson<Record<string, string>>(r.dims, {}),
        })),
      };
    }

    // Aggregated: bucket by time using SQLite strftime
    const bucketFmt = bucketFormat(agg.bucket);
    const unit = this.getUnit(metric);

    let aggSql: string;
    if (agg.fn === "last") {
      // LAST: pick the value with the maximum ts per bucket
      const rows = this.db
        .prepare(
          `SELECT strftime('${bucketFmt}', ts) as bucket,
                  value, ts
           FROM metric_points
           WHERE metric = ? AND ts >= ? AND ts <= ?
           ORDER BY ts ASC`
        )
        .all(metric, range.from, range.to) as Array<{
        bucket: string;
        value: number;
        ts: string;
      }>;

      // Keep last value per bucket
      const byBucket = new Map<string, { ts: string; value: number }>();
      for (const r of rows) {
        const existing = byBucket.get(r.bucket);
        if (!existing || r.ts > existing.ts) {
          byBucket.set(r.bucket, { ts: r.ts, value: r.value });
        }
      }

      return {
        metric,
        unit,
        agg,
        points: [...byBucket.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([bucket, { value }]) => ({ ts: bucket, value })),
      };
    }

    aggSql = `
      SELECT strftime('${bucketFmt}', ts) as bucket,
             ${aggFn(agg.fn)}(value) as value
      FROM metric_points
      WHERE metric = ? AND ts >= ? AND ts <= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const rows = this.db.prepare(aggSql).all(metric, range.from, range.to) as Array<{
      bucket: string;
      value: number;
    }>;

    return {
      metric,
      unit,
      agg,
      points: rows.map((r) => ({ ts: r.bucket, value: r.value })),
    };
  }

  /** Return the latest MetricPoint for a metric, optionally filtered by source. */
  latest(metric: string, source?: string): MetricPoint | null {
    let row: Record<string, unknown> | undefined;
    if (source) {
      row = this.db
        .prepare(
          `SELECT * FROM metric_points
           WHERE metric = ? AND source = ?
           ORDER BY ts DESC LIMIT 1`
        )
        .get(metric, source) as Record<string, unknown> | undefined;
    } else {
      row = this.db
        .prepare(
          `SELECT * FROM metric_points
           WHERE metric = ?
           ORDER BY ts DESC LIMIT 1`
        )
        .get(metric) as Record<string, unknown> | undefined;
    }

    if (!row) return null;
    return rowToPoint(row);
  }

  private getUnit(metric: string): string {
    const row = this.db
      .prepare(
        `SELECT unit FROM metric_points WHERE metric = ? LIMIT 1`
      )
      .get(metric) as { unit: string } | undefined;
    return row?.unit ?? "";
  }
}

function rowToPoint(row: Record<string, unknown>): MetricPoint {
  return {
    id: row["id"] as string,
    source: row["source"] as MetricPoint["source"],
    metric: row["metric"] as string,
    value: row["value"] as number,
    unit: row["unit"] as string,
    ts: row["ts"] as string,
    dims: fromJson<Record<string, string>>(row["dims"] as string | null, {}),
    ingestedAt: row["ingested_at"] as string,
    adapterVersion: row["adapter_version"] as string,
  };
}

function bucketFormat(bucket: "1h" | "1d" | "1w"): string {
  switch (bucket) {
    case "1h":
      return "%Y-%m-%dT%H:00:00Z";
    case "1d":
      return "%Y-%m-%d";
    case "1w":
      // ISO week: use start of week (Monday) — approximate with strftime %W
      return "%Y-W%W";
  }
}

function aggFn(fn: "sum" | "avg" | "min" | "max"): string {
  switch (fn) {
    case "sum":
      return "SUM";
    case "avg":
      return "AVG";
    case "min":
      return "MIN";
    case "max":
      return "MAX";
  }
}
