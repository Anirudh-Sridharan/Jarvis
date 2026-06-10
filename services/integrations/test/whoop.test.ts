/**
 * Whoop connector tests:
 *   - normalizeWhoopRecovery → correct MetricPoints (HRV / RHR / recovery)
 *   - normalizeWhoopSleep → correct MetricPoints (duration / stages / efficiency)
 *   - PENDING_SCORE records produce no MetricPoints
 *   - Naps excluded from night sleep metrics
 *   - sync() hits v2 endpoints, follows next_token pagination, advances cursor
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  whoopConnector,
  normalizeWhoopRecovery,
  normalizeWhoopSleep,
  normalizeWhoopCycle,
} from "../src/connectors/whoop.js";
import { clearOAuthState } from "../src/framework/oauth.js";
import {
  FakeHttp,
  MemoryTokenStore,
  makeTokens,
  whoopRecoveryFixture,
  whoopSleepFixture,
} from "../src/testing/fakes.js";

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

  it("keeps a legitimate strain of 0 (rest day)", () => {
    const fixture = {
      id: 3,
      start: "2026-06-09T00:00:00Z",
      score_state: "SCORED" as const,
      score: { strain: 0 },
    };
    const points = normalizeWhoopCycle(fixture);
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(0);
  });

  it("returns no points when strain is missing", () => {
    const fixture = {
      id: 4,
      start: "2026-06-09T00:00:00Z",
      score_state: "SCORED" as const,
      score: {},
    };
    expect(normalizeWhoopCycle(fixture)).toHaveLength(0);
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

describe("whoopConnector.sync", () => {
  let http: FakeHttp;
  let tokenStore: MemoryTokenStore;

  const emptyPage = { status: 200, headers: {}, body: { records: [], next_token: null } };

  beforeEach(() => {
    http = new FakeHttp();
    tokenStore = new MemoryTokenStore();
    tokenStore.seed("whoop", makeTokens({ expiresAt: Date.now() + 3600_000 }));
    clearOAuthState();
  });

  afterEach(() => clearOAuthState());

  it("hits the v2 developer endpoints", async () => {
    http.add("/developer/v2/recovery", { status: 200, headers: {}, body: whoopRecoveryFixture() });
    http.add("/developer/v2/activity/sleep", { status: 200, headers: {}, body: whoopSleepFixture() });
    http.add("/developer/v2/cycle", emptyPage);

    const result = await whoopConnector.sync(null, http, tokenStore);

    expect(http.callCount("/developer/v2/recovery")).toBe(1);
    expect(http.callCount("/developer/v2/activity/sleep")).toBe(1);
    expect(http.callCount("/developer/v2/cycle")).toBe(1);
    expect(http.calls.every((c) => !c.req.url.includes("/developer/v1/"))).toBe(true);
    expect(result.points.length).toBeGreaterThan(0);
  });

  it("follows next_token pagination within a collection", async () => {
    const page1 = {
      status: 200,
      headers: {},
      body: { ...(whoopRecoveryFixture() as object), next_token: "page2" },
    };
    const page2 = { status: 200, headers: {}, body: whoopRecoveryFixture() };
    http.add("/developer/v2/recovery", [page1, page2]);
    http.add("/developer/v2/activity/sleep", emptyPage);
    http.add("/developer/v2/cycle", emptyPage);

    const result = await whoopConnector.sync(null, http, tokenStore);

    expect(http.callCount("/developer/v2/recovery")).toBe(2);
    const secondCall = http.calls.filter((c) => c.req.url.includes("recovery"))[1];
    expect(secondCall?.req.url).toContain("nextToken=page2");
    // 4 metric points per recovery record × 2 pages
    expect(result.points.filter((p) => p.metric === "recovery")).toHaveLength(2);
  });

  it("advances the cursor to the latest record timestamp", async () => {
    http.add("/developer/v2/recovery", { status: 200, headers: {}, body: whoopRecoveryFixture() });
    http.add("/developer/v2/activity/sleep", emptyPage);
    http.add("/developer/v2/cycle", emptyPage);

    const result = await whoopConnector.sync(null, http, tokenStore);
    expect(result.nextCursor).toBe("2026-06-09T07:00:00Z"); // fixture created_at
  });

  it("throws when a collection returns non-200 (cursor must not advance past a failed collection)", async () => {
    // The shared cursor advances by the max ts across ALL collections, so a
    // silently-skipped 429 collection would permanently lose its window.
    // The sync must throw; the Scheduler records an error run and keeps the cursor.
    http.add("/developer/v2/recovery", { status: 429, headers: {}, body: {} });
    http.add("/developer/v2/activity/sleep", { status: 200, headers: {}, body: whoopSleepFixture() });
    http.add("/developer/v2/cycle", emptyPage);

    await expect(whoopConnector.sync(null, http, tokenStore)).rejects.toThrow(
      /recovery sync failed: HTTP 429/
    );
  });

  it("throws on a mid-collection failure too (500 on sleep)", async () => {
    http.add("/developer/v2/recovery", emptyPage);
    http.add("/developer/v2/activity/sleep", { status: 500, headers: {}, body: {} });
    http.add("/developer/v2/cycle", emptyPage);

    await expect(whoopConnector.sync(null, http, tokenStore)).rejects.toThrow(
      /activity\/sleep sync failed: HTTP 500/
    );
  });

  it("passes the incoming cursor as the start window", async () => {
    http.add("/developer/v2/recovery", emptyPage);
    http.add("/developer/v2/activity/sleep", emptyPage);
    http.add("/developer/v2/cycle", emptyPage);

    const cursor = {
      source: "whoop" as const,
      stream: "whoop.sync",
      highWater: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00Z",
    };
    const result = await whoopConnector.sync(cursor, http, tokenStore);

    const firstCall = http.calls[0];
    expect(firstCall?.req.url).toContain(encodeURIComponent("2026-06-01T00:00:00.000Z"));
    expect(result.nextCursor).toBeNull(); // nothing new → cursor unchanged
  });
});
