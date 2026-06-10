/**
 * MetricStore tests:
 *   - Idempotent upsert: re-inserting same MetricPoints doesn't create duplicates
 *   - querySeries: range filter, raw resolution, aggregated buckets
 *   - latest(): returns most recent point
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../src/db/schema.js";
import { MetricStore, makeMetricId } from "../src/framework/metricStore.js";
import type { MetricPoint } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  applySchema(db);
  return db;
}

function makePoint(overrides: Partial<MetricPoint> = {}): MetricPoint {
  const base: Omit<MetricPoint, "id"> = {
    source: "whoop",
    metric: "hrv",
    value: 45.5,
    unit: "ms",
    ts: "2026-06-09T07:00:00Z",
    dims: {},
    ingestedAt: "2026-06-09T08:00:00Z",
    adapterVersion: "1",
    ...overrides,
  };
  return { ...base, id: makeMetricId(base) };
}

describe("MetricStore", () => {
  let store: MetricStore;

  beforeEach(() => {
    store = new MetricStore(makeDb());
  });

  describe("upsertSeries", () => {
    it("inserts a new point and reports inserted=1", () => {
      const pt = makePoint();
      const result = store.upsertSeries([pt]);
      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("idempotent: re-inserting same point does NOT create a duplicate", () => {
      const pt = makePoint();
      store.upsertSeries([pt]);
      const result = store.upsertSeries([pt]);
      // Second upsert: same id → update path, NOT duplicate
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);

      // querySeries should still return exactly 1 point
      const series = store.querySeries("hrv", {
        from: "2026-06-09T00:00:00Z",
        to: "2026-06-09T23:59:59Z",
      });
      expect(series.points).toHaveLength(1);
    });

    it("inserts multiple points for different sources + metrics", () => {
      const pts = [
        makePoint({ source: "whoop", metric: "hrv", value: 45, ts: "2026-06-09T07:00:00Z" }),
        makePoint({ source: "apple_health", metric: "hrv", value: 42, ts: "2026-06-09T07:00:00Z" }),
        makePoint({ source: "whoop", metric: "restingHr", value: 52, ts: "2026-06-09T07:00:00Z" }),
      ].map((p) => ({ ...p, id: makeMetricId(p) }));

      const result = store.upsertSeries(pts);
      expect(result.inserted).toBe(3);
    });

    it("updates value on re-upsert with same id (last-write wins)", () => {
      const pt = makePoint({ value: 45 });
      store.upsertSeries([pt]);

      // Same id, different value (e.g. corrected data)
      const updated = { ...pt, value: 48 };
      store.upsertSeries([updated]);

      const series = store.querySeries("hrv", {
        from: "2026-06-09T00:00:00Z",
        to: "2026-06-09T23:59:59Z",
      });
      expect(series.points[0]?.value).toBe(48);
    });

    it("handles overlapping windows without duplicates", () => {
      // Simulate two sync runs with overlapping time windows
      const run1 = [
        makePoint({ ts: "2026-06-07T07:00:00Z", value: 40 }),
        makePoint({ ts: "2026-06-08T07:00:00Z", value: 42 }),
        makePoint({ ts: "2026-06-09T07:00:00Z", value: 45 }),
      ].map((p) => ({ ...p, id: makeMetricId(p) }));

      const run2 = [
        // Overlap: days 8 and 9 appear again
        makePoint({ ts: "2026-06-08T07:00:00Z", value: 42 }),
        makePoint({ ts: "2026-06-09T07:00:00Z", value: 45 }),
        makePoint({ ts: "2026-06-10T07:00:00Z", value: 47 }),
      ].map((p) => ({ ...p, id: makeMetricId(p) }));

      store.upsertSeries(run1);
      store.upsertSeries(run2);

      const series = store.querySeries("hrv", {
        from: "2026-06-07T00:00:00Z",
        to: "2026-06-10T23:59:59Z",
      });

      // Should have exactly 4 distinct points (days 7, 8, 9, 10)
      expect(series.points).toHaveLength(4);
    });
  });

  describe("querySeries", () => {
    beforeEach(() => {
      // Seed 7 days of HRV data
      const points = Array.from({ length: 7 }, (_, i) => {
        const date = `2026-06-0${i + 1}`;
        const ts = `${date}T07:00:00Z`;
        const p = makePoint({ ts, value: 40 + i });
        return { ...p, id: makeMetricId(p) };
      });
      store.upsertSeries(points);
    });

    it("returns points in range (raw resolution)", () => {
      const series = store.querySeries("hrv", {
        from: "2026-06-03T00:00:00Z",
        to: "2026-06-05T23:59:59Z",
      });
      expect(series.points).toHaveLength(3);
      expect(series.points.map((p) => p.value)).toEqual([42, 43, 44]);
    });

    it("returns empty array for range with no data", () => {
      const series = store.querySeries("hrv", {
        from: "2027-01-01T00:00:00Z",
        to: "2027-01-31T23:59:59Z",
      });
      expect(series.points).toHaveLength(0);
    });

    it("aggregates with avg by day", () => {
      // Add a second point for same day
      const extra = makePoint({
        ts: "2026-06-01T20:00:00Z",
        value: 50,
        dims: { session: "evening" },
      });
      store.upsertSeries([{ ...extra, id: makeMetricId(extra) }]);

      const series = store.querySeries(
        "hrv",
        { from: "2026-06-01T00:00:00Z", to: "2026-06-01T23:59:59Z" },
        { fn: "avg", bucket: "1d" }
      );

      expect(series.agg?.fn).toBe("avg");
      expect(series.points).toHaveLength(1);
      // avg of 40 and 50 = 45
      expect(series.points[0]?.value).toBeCloseTo(45);
    });

    it("aggregates with sum by day", () => {
      const series = store.querySeries(
        "hrv",
        { from: "2026-06-01T00:00:00Z", to: "2026-06-07T23:59:59Z" },
        { fn: "sum", bucket: "1d" }
      );
      // One point per day, so sum == original value
      expect(series.points).toHaveLength(7);
    });

    it("aggregates with last by day", () => {
      // Add earlier point for same day
      const early = makePoint({ ts: "2026-06-05T06:00:00Z", value: 99 });
      store.upsertSeries([{ ...early, id: makeMetricId(early) }]);

      const series = store.querySeries(
        "hrv",
        { from: "2026-06-05T00:00:00Z", to: "2026-06-05T23:59:59Z" },
        { fn: "last", bucket: "1d" }
      );

      // Should pick the point with the latest ts (07:00, value=44)
      expect(series.points[0]?.value).toBe(44);
    });
  });

  describe("latest()", () => {
    it("returns most recent MetricPoint for a metric", () => {
      const points = [
        makePoint({ ts: "2026-06-01T07:00:00Z", value: 40 }),
        makePoint({ ts: "2026-06-09T07:00:00Z", value: 55 }),
        makePoint({ ts: "2026-06-05T07:00:00Z", value: 47 }),
      ].map((p) => ({ ...p, id: makeMetricId(p) }));
      store.upsertSeries(points);

      const latest = store.latest("hrv");
      expect(latest?.value).toBe(55);
      expect(latest?.ts).toBe("2026-06-09T07:00:00Z");
    });

    it("returns null when no data exists", () => {
      expect(store.latest("nonexistent_metric")).toBeNull();
    });

    it("filters by source", () => {
      const apple = makePoint({ source: "apple_health", value: 38 });
      const whoop = makePoint({ source: "whoop", value: 45 });
      store.upsertSeries([
        { ...apple, id: makeMetricId(apple) },
        { ...whoop, id: makeMetricId(whoop) },
      ]);

      const appleLatest = store.latest("hrv", "apple_health");
      expect(appleLatest?.value).toBe(38);

      const whoopLatest = store.latest("hrv", "whoop");
      expect(whoopLatest?.value).toBe(45);
    });
  });

  describe("makeMetricId", () => {
    it("is deterministic: same inputs → same id", () => {
      const a = makeMetricId({ source: "whoop", metric: "hrv", ts: "2026-06-09T07:00:00Z", dims: {} });
      const b = makeMetricId({ source: "whoop", metric: "hrv", ts: "2026-06-09T07:00:00Z", dims: {} });
      expect(a).toBe(b);
    });

    it("dims order does not matter", () => {
      const a = makeMetricId({ source: "whoop", metric: "hrv", ts: "2026-06-09T07:00:00Z", dims: { a: "1", b: "2" } });
      const b = makeMetricId({ source: "whoop", metric: "hrv", ts: "2026-06-09T07:00:00Z", dims: { b: "2", a: "1" } });
      expect(a).toBe(b);
    });

    it("different source → different id", () => {
      const a = makeMetricId({ source: "whoop", metric: "hrv", ts: "2026-06-09T07:00:00Z", dims: {} });
      const b = makeMetricId({ source: "apple_health", metric: "hrv", ts: "2026-06-09T07:00:00Z", dims: {} });
      expect(a).not.toBe(b);
    });
  });
});
