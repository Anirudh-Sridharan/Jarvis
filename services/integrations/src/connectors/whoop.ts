/**
 * Whoop connector — OAuth2 with ROTATING refresh token (serialized).
 *
 * Endpoints (v2 — v1 was sunset 2025-10-01):
 *   GET /developer/v2/recovery        → recovery/HRV/RHR → MetricPoints
 *   GET /developer/v2/activity/sleep  → sleep duration/stages → MetricPoints
 *   GET /developer/v2/cycle           → strain → MetricPoints
 *
 * Pagination: each collection returns { records, next_token }; pass it back as
 * ?nextToken= until exhausted (page-count capped).
 *
 * Rotating refresh: handled by oauth.ts getAccessToken(..., isRotating=true);
 * the refresh grant re-sends scope=offline (provider catalog).
 * Concurrency must be 1 at the scheduler level for Whoop.
 */

import type {
  Connector,
  ConnectorSyncResult,
  Cursor,
  HttpClient,
  MetricPoint,
  TokenStore,
} from "../types.js";
import { makeMetricId } from "../framework/metricStore.js";
import { getAccessToken } from "../framework/oauth.js";
import { getRefreshConfig } from "../framework/providers.js";

const ADAPTER_VERSION = "1";
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer/v2";
const MAX_PAGES_PER_COLLECTION = 10;

export const whoopConnector: Connector = {
  id: "whoop",
  auth: "oauth",
  schedule: "0 7 * * *", // 07:00 UTC daily (after sleep scoring is ready)
  concurrency: 1,         // MUST be 1 — rotating refresh token requires serialization

  async sync(
    cursor: Cursor | null,
    http: HttpClient,
    tokenStore: TokenStore
  ): Promise<ConnectorSyncResult> {
    const token = await getAccessToken(
      "whoop",
      tokenStore,
      http,
      getRefreshConfig("whoop"),
      true // isRotating = true → serialized refresh critical section
    );

    const since = cursor?.highWater ?? thirtyDaysAgo();
    const points: MetricPoint[] = [];
    let latestTs = since;

    const collect = <T>(records: T[], normalize: (r: T) => MetricPoint[]) => {
      for (const r of records) {
        const pts = normalize(r);
        points.push(...pts);
        for (const p of pts) {
          if (p.ts > latestTs) latestTs = p.ts;
        }
      }
    };

    collect(
      await fetchAllPages<WhoopRecovery>(http, token, "recovery", since),
      normalizeWhoopRecovery
    );
    collect(
      await fetchAllPages<WhoopSleep>(http, token, "activity/sleep", since),
      normalizeWhoopSleep
    );
    collect(
      await fetchAllPages<WhoopCycle>(http, token, "cycle", since),
      normalizeWhoopCycle
    );

    return {
      points,
      nextCursor: latestTs !== since ? latestTs : null,
    };
  },
};

/** Page through a v2 collection endpoint via next_token until exhausted. */
async function fetchAllPages<T>(
  http: HttpClient,
  token: string,
  collection: string,
  since: string
): Promise<T[]> {
  const records: T[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page++) {
    const params = new URLSearchParams({ start: since, limit: "25" });
    if (nextToken) params.set("nextToken", nextToken);

    const res = await http.request({
      method: "GET",
      url: `${WHOOP_API_BASE}/${collection}?${params}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    // Non-200 (rate limit, transient 5xx, auth failure): fail the whole run.
    // The shared cursor advances past the max ts across ALL collections, so
    // silently skipping one collection would permanently lose its window.
    // Throwing makes the Scheduler record an error run without advancing.
    if (res.status !== 200) {
      throw new Error(`Whoop ${collection} sync failed: HTTP ${res.status}`);
    }

    const data = res.body as { records?: T[]; next_token?: string | null };
    records.push(...(data.records ?? []));

    if (!data.next_token) break;
    nextToken = data.next_token;
  }

  return records;
}

// ── Normalizers ────────────────────────────────────────────────────────────────

interface WhoopScore {
  recovery_score?: number;
  hrv_rmssd_milli?: number;
  resting_heart_rate?: number;
  spo2_percentage?: number;
  skin_temp_celsius?: number;
}

interface WhoopRecovery {
  cycle_id?: number;
  created_at?: string;
  score_state?: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: WhoopScore;
}

interface WhoopSleepStages {
  total_in_bed_time_milli?: number;
  total_awake_time_milli?: number;
  total_light_sleep_time_milli?: number;
  total_slow_wave_sleep_time_milli?: number;
  total_rem_sleep_time_milli?: number;
}

interface WhoopSleepScore {
  stage_summary?: WhoopSleepStages;
  sleep_performance_percentage?: number;
  respiratory_rate?: number;
}

interface WhoopSleep {
  id?: number | string; // v2 sleep IDs are UUID strings
  start?: string;
  end?: string;
  score_state?: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: WhoopSleepScore;
  nap?: boolean;
}

interface WhoopCycle {
  id?: number;
  start?: string;
  score_state?: "SCORED" | "PENDING_SCORE" | "UNSCORABLE";
  score?: { strain?: number };
}

export function normalizeWhoopRecovery(r: WhoopRecovery): MetricPoint[] {
  if (r.score_state !== "SCORED" || !r.score) return [];

  const ts = r.created_at ?? new Date().toISOString();
  const ingestedAt = new Date().toISOString();
  const points: MetricPoint[] = [];

  const add = (metric: string, value: number | undefined, unit: string) => {
    if (value == null) return;
    points.push({
      id: makeMetricId({ source: "whoop", metric, ts, dims: {} }),
      source: "whoop",
      metric,
      value,
      unit,
      ts,
      dims: {},
      ingestedAt,
      adapterVersion: ADAPTER_VERSION,
    });
  };

  add("recovery", r.score.recovery_score, "%");
  add("hrv", r.score.hrv_rmssd_milli, "ms");
  add("restingHr", r.score.resting_heart_rate, "bpm");
  add("spo2", r.score.spo2_percentage, "%");

  return points;
}

export function normalizeWhoopSleep(s: WhoopSleep): MetricPoint[] {
  if (!s.score?.stage_summary) return [];

  const ts = s.end ?? s.start ?? new Date().toISOString();
  const ingestedAt = new Date().toISOString();
  const points: MetricPoint[] = [];
  const st = s.score.stage_summary;

  const ms2min = (ms?: number): number =>
    ms ? Math.round(ms / 60_000) : 0;

  const inBedMin = ms2min(st.total_in_bed_time_milli);
  const awakeMin = ms2min(st.total_awake_time_milli);
  const asleepMin = inBedMin - awakeMin;

  if (inBedMin > 0) {
    const add = (metric: string, value: number, unit: string, dims?: Record<string, string>) => {
      if (!s.nap) { // exclude naps from night summary
        points.push({
          id: makeMetricId({ source: "whoop", metric, ts, dims: dims ?? {} }),
          source: "whoop",
          metric,
          value,
          unit,
          ts,
          dims: dims ?? {},
          ingestedAt,
          adapterVersion: ADAPTER_VERSION,
        });
      }
    };

    add("sleep.duration_min", asleepMin, "min");
    add("sleep.efficiency", inBedMin > 0 ? (asleepMin / inBedMin) * 100 : 0, "%");
    add("sleep.stage_awake_min", awakeMin, "min", { stage: "awake" });
    add("sleep.stage_light_min", ms2min(st.total_light_sleep_time_milli), "min", { stage: "light" });
    add("sleep.stage_deep_min", ms2min(st.total_slow_wave_sleep_time_milli), "min", { stage: "deep" });
    add("sleep.stage_rem_min", ms2min(st.total_rem_sleep_time_milli), "min", { stage: "rem" });

    if (s.score.respiratory_rate != null) {
      add("respiratoryRate", s.score.respiratory_rate, "breaths/min");
    }
  }

  return points;
}

export function normalizeWhoopCycle(c: WhoopCycle): MetricPoint[] {
  // `== null` (not falsy check): a strain of 0 is a legitimate rest day.
  const strain = c.score?.strain;
  if (c.score_state !== "SCORED" || strain == null) return [];

  const ts = c.start ?? new Date().toISOString();
  const ingestedAt = new Date().toISOString();

  return [
    {
      id: makeMetricId({ source: "whoop", metric: "strain", ts, dims: {} }),
      source: "whoop",
      metric: "strain",
      value: strain,
      unit: "score",
      ts,
      dims: {},
      ingestedAt,
      adapterVersion: ADAPTER_VERSION,
    },
  ];
}

function thirtyDaysAgo(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}
