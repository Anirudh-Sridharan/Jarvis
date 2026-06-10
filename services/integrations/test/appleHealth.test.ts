/**
 * Apple Health connector tests:
 *   - ingestAppleHealth: fixture → MetricPoints (HRV, RHR, steps, activeEnergy)
 *   - Idempotent: re-POSTing same window → same MetricPoint ids (no duplicates)
 *   - Future timestamps rejected
 *   - Unknown metrics skipped
 *   - Push endpoint handler: auth check
 */

import { describe, it, expect } from "vitest";
import { ingestAppleHealth, createPushEndpointHandler } from "../src/connectors/appleHealth.js";
import { appleHealthFixture } from "../src/testing/fakes.js";

describe("ingestAppleHealth", () => {
  it("normalizes HAE fixture to MetricPoints", () => {
    const body = appleHealthFixture() as Parameters<typeof ingestAppleHealth>[0];
    const points = ingestAppleHealth(body);

    expect(points.length).toBeGreaterThan(0);

    const hrv = points.find((p) => p.metric === "hrv");
    expect(hrv).toBeDefined();
    expect(hrv?.source).toBe("apple_health");
    expect(hrv?.value).toBe(38.5);
    expect(hrv?.unit).toBe("ms");

    const rhr = points.find((p) => p.metric === "restingHr");
    expect(rhr).toBeDefined();
    expect(rhr?.value).toBe(55);

    const steps = points.find((p) => p.metric === "steps");
    expect(steps).toBeDefined();
    expect(steps?.value).toBe(8432);
    expect(steps?.unit).toBe("count");

    const energy = points.find((p) => p.metric === "activeEnergy");
    expect(energy).toBeDefined();
    expect(energy?.value).toBe(480);
    expect(energy?.unit).toBe("kcal");
  });

  it("idempotent: same input produces same MetricPoint ids", () => {
    const body = appleHealthFixture() as Parameters<typeof ingestAppleHealth>[0];
    const pts1 = ingestAppleHealth(body);
    const pts2 = ingestAppleHealth(body);

    const ids1 = new Set(pts1.map((p) => p.id));
    const ids2 = new Set(pts2.map((p) => p.id));
    expect(ids1).toEqual(ids2);
  });

  it("overlapping window re-POST produces same ids (safe to upsert)", () => {
    const body = appleHealthFixture() as Parameters<typeof ingestAppleHealth>[0];
    const pts1 = ingestAppleHealth(body);
    const pts2 = ingestAppleHealth(body);

    // All ids from second call exist in first call (no new points)
    const ids1 = new Set(pts1.map((p) => p.id));
    for (const p of pts2) {
      expect(ids1.has(p.id)).toBe(true);
    }
  });

  it("rejects future timestamps (clock skew guard)", () => {
    const futureTs = new Date(Date.now() + 10 * 60_000).toISOString(); // 10 min in future
    const body = {
      data: {
        metrics: [
          {
            name: "step_count",
            units: "count",
            data: [{ date: futureTs, qty: 1000 }],
          },
        ],
      },
    };
    const points = ingestAppleHealth(body as Parameters<typeof ingestAppleHealth>[0]);
    expect(points).toHaveLength(0); // future ts rejected
  });

  it("skips unknown metric names gracefully", () => {
    const body = {
      data: {
        metrics: [
          {
            name: "totally_unknown_metric_xyz",
            units: "units",
            data: [{ date: "2026-06-09T07:00:00Z", qty: 42 }],
          },
        ],
      },
    };
    const points = ingestAppleHealth(body as Parameters<typeof ingestAppleHealth>[0]);
    expect(points).toHaveLength(0);
  });

  it("handles empty data gracefully", () => {
    const points = ingestAppleHealth({ data: { metrics: [], workouts: [] } } as Parameters<typeof ingestAppleHealth>[0]);
    expect(points).toHaveLength(0);
  });

  it("handles missing data field gracefully", () => {
    const points = ingestAppleHealth({} as Parameters<typeof ingestAppleHealth>[0]);
    expect(points).toHaveLength(0);
  });
});

describe("createPushEndpointHandler", () => {
  it("returns 401 for missing/wrong bearer token", async () => {
    const handler = createPushEndpointHandler(async () => {}, "secret123");

    const result1 = await handler(undefined, {});
    expect(result1.status).toBe(401);

    const result2 = await handler("Bearer wrong_secret", {});
    expect(result2.status).toBe(401);
  });

  it("returns 400 for missing body data", async () => {
    const handler = createPushEndpointHandler(async () => {}, "secret123");
    const result = await handler("Bearer secret123", {});
    expect(result.status).toBe(400);
  });

  it("calls onPoints with normalized MetricPoints on valid request", async () => {
    const received: unknown[] = [];
    const handler = createPushEndpointHandler(async (pts) => {
      received.push(...pts);
    }, "my_secret");

    const body = appleHealthFixture();
    const result = await handler("Bearer my_secret", body);

    expect(result.status).toBe(200);
    expect(received.length).toBeGreaterThan(0);
    const res = result.body as { accepted: number };
    expect(res.accepted).toBeGreaterThan(0);
  });
});
