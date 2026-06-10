/**
 * Whoop connector tests:
 *   - normalizeWhoopRecovery → correct MetricPoints (HRV / RHR / recovery)
 *   - normalizeWhoopSleep → correct MetricPoints (duration / stages / efficiency)
 *   - PENDING_SCORE records produce no MetricPoints
 *   - Naps excluded from night sleep metrics
 */

import { describe, it, expect } from "vitest";
import {
  normalizeWhoopRecovery,
  normalizeWhoopSleep,
  normalizeWhoopCycle,
} from "../src/connectors/whoop.js";
import { whoopRecoveryFixture, whoopSleepFixture } from "../src/testing/fakes.js";

describe("normalizeWhoopRecovery", () => {
  it("extracts recovery, hrv, restingHr from SCORED record", () => {
    const fixture = (whoopRecoveryFixture() as { records: object[] }).records[0];
    const points = normalizeWhoopRecovery(fixture as Parameters<typeof normalizeWhoopRecovery>[0]);

    expect(points).toHaveLength(4); // recovery, hrv, restingHr, spo2

    const recovery = points.find((p) => p.metric === "recovery");
    expect(recovery?.value).toBe(72);
    expect(recovery?.unit).toBe("%");
    expect(recovery?.source).toBe("whoop");

    const hrv = points.find((p) => p.metric === "hrv");
    expect(hrv?.value).toBeCloseTo(45.5);
    expect(hrv?.unit).toBe("ms");

    const rhr = points.find((p) => p.metric === "restingHr");
    expect(rhr?.value).toBe(52);
    expect(rhr?.unit).toBe("bpm");

    const spo2 = points.find((p) => p.metric === "spo2");
    expect(spo2?.value).toBeCloseTo(97.8);
  });

  it("returns no points for PENDING_SCORE records", () => {
    const fixture = {
      cycle_id: 99,
      created_at: "2026-06-09T07:00:00Z",
      score_state: "PENDING_SCORE",
      score: { recovery_score: 50, hrv_rmssd_milli: 40, resting_heart_rate: 55 },
    };
    const points = normalizeWhoopRecovery(fixture);
    expect(points).toHaveLength(0);
  });

  it("returns no points for UNSCORABLE records", () => {
    const fixture = {
      cycle_id: 100,
      created_at: "2026-06-09T07:00:00Z",
      score_state: "UNSCORABLE",
      score: null,
    };
    const points = normalizeWhoopRecovery(fixture);
    expect(points).toHaveLength(0);
  });

  it("produces deterministic ids (same input → same id)", () => {
    const fixture = (whoopRecoveryFixture() as { records: object[] }).records[0];
    const pts1 = normalizeWhoopRecovery(fixture as Parameters<typeof normalizeWhoopRecovery>[0]);
    const pts2 = normalizeWhoopRecovery(fixture as Parameters<typeof normalizeWhoopRecovery>[0]);

    expect(pts1.map((p) => p.id)).toEqual(pts2.map((p) => p.id));
  });

  it("handles missing optional fields gracefully", () => {
    const fixture = {
      cycle_id: 200,
      created_at: "2026-06-09T07:00:00Z",
      score_state: "SCORED" as const,
      score: {
        recovery_score: 65,
        hrv_rmssd_milli: 38,
        resting_heart_rate: 58,
        // spo2 and skin_temp missing
      },
    };
    const points = normalizeWhoopRecovery(fixture);
    expect(points).toHaveLength(3); // recovery, hrv, restingHr (no spo2)
    expect(points.every((p) => p.value != null)).toBe(true);
  });
});

describe("normalizeWhoopSleep", () => {
  it("extracts sleep duration from SCORED record", () => {
    const fixture = (whoopSleepFixture() as { records: object[] }).records[0];
    const points = normalizeWhoopSleep(fixture as Parameters<typeof normalizeWhoopSleep>[0]);

    const duration = points.find((p) => p.metric === "sleep.duration_min");
    expect(duration).toBeDefined();
    // 465 min in bed - 50 min awake = 415 min asleep
    expect(duration?.value).toBe(415);
    expect(duration?.unit).toBe("min");
  });

  it("extracts sleep efficiency", () => {
    const fixture = (whoopSleepFixture() as { records: object[] }).records[0];
    const points = normalizeWhoopSleep(fixture as Parameters<typeof normalizeWhoopSleep>[0]);

    const efficiency = points.find((p) => p.metric === "sleep.efficiency");
    expect(efficiency).toBeDefined();
    // 415 / 465 * 100 ≈ 89.2%
    expect(efficiency?.value).toBeCloseTo(89.2, 0);
  });

  it("extracts sleep stages (rem, deep, light, awake)", () => {
    const fixture = (whoopSleepFixture() as { records: object[] }).records[0];
    const points = normalizeWhoopSleep(fixture as Parameters<typeof normalizeWhoopSleep>[0]);

    const rem = points.find((p) => p.metric === "sleep.stage_rem_min");
    expect(rem?.value).toBe(155); // 9300000ms / 60000 = 155min

    const deep = points.find((p) => p.metric === "sleep.stage_deep_min");
    expect(deep?.value).toBe(110); // 6600000ms / 60000 = 110min

    const light = points.find((p) => p.metric === "sleep.stage_light_min");
    expect(light?.value).toBe(150);

    const awake = points.find((p) => p.metric === "sleep.stage_awake_min");
    expect(awake?.value).toBe(50);
  });

  it("extracts respiratory rate when present", () => {
    const fixture = (whoopSleepFixture() as { records: object[] }).records[0];
    const points = normalizeWhoopSleep(fixture as Parameters<typeof normalizeWhoopSleep>[0]);

    const rr = points.find((p) => p.metric === "respiratoryRate");
    expect(rr?.value).toBeCloseTo(14.2);
    expect(rr?.unit).toBe("breaths/min");
  });

  it("returns no points for nap records", () => {
    const fixture = { ...(whoopSleepFixture() as { records: object[] }).records[0], nap: true };
    const points = normalizeWhoopSleep(fixture as Parameters<typeof normalizeWhoopSleep>[0]);
    expect(points).toHaveLength(0);
  });

  it("returns no points when stage_summary is missing", () => {
    const fixture = {
      id: 100,
      start: "2026-06-08T22:30:00Z",
      end: "2026-06-09T06:15:00Z",
      score_state: "SCORED" as const,
      score: {},
      nap: false,
    };
    const points = normalizeWhoopSleep(fixture);
    expect(points).toHaveLength(0);
  });
});

describe("normalizeWhoopCycle", () => {
  it("extracts strain from SCORED cycle", () => {
    const fixture = {
      id: 1,
      start: "2026-06-09T00:00:00Z",
      score_state: "SCORED" as const,
      score: { strain: 14.5 },
    };
    const points = normalizeWhoopCycle(fixture);
    expect(points).toHaveLength(1);
    expect(points[0]?.metric).toBe("strain");
    expect(points[0]?.value).toBe(14.5);
    expect(points[0]?.unit).toBe("score");
  });

  it("returns no points for unscorable cycle", () => {
    const fixture = {
      id: 2,
      start: "2026-06-09T00:00:00Z",
      score_state: "PENDING_SCORE" as const,
      score: { strain: 10 },
    };
    const points = normalizeWhoopCycle(fixture);
    expect(points).toHaveLength(0);
  });
});
