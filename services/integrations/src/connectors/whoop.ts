/**
 * Whoop connector — OAuth2 with ROTATING refresh token (serialized).
 *
 * Endpoints:
 *   GET /v1/recovery  → recovery/HRV/RHR → MetricPoints
 *   GET /v1/activity/sleep → sleep duration/stages → MetricPoints
 *   GET /v1/cycle      → strain → MetricPoints
 *
 * Rotating refresh: handled by oauth.ts getAccessToken(..., isRotating=true).
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

const ADAPTER_VERSION = "1";

const WHOOP_OAUTH_CONFIG = {
  tokenUrl: "https://api.prod.whoop.com/oauth/token",
  clientId: process.env["WHOOP_CLIENT_ID"] ?? "whoop_client",
  clientSecret: process.env["WHOOP_CLIENT_SECRET"] ?? "whoop_secret",
};

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
      WHOOP_OAUTH_CONFIG,
      true // isRotating = true → serialized refresh critical section
    );

    const since = cursor?.highWater ?? thirtyDaysAgo();
    const points: MetricPoint[] = [];
    let latestTs = since;

    // Fetch recovery records
    const recoveryRes = await http.request({
      method: "GET",
      url: `https://api.prod.whoop.com/developer/v1/recovery?start=${since}&limit=25`,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (recoveryRes.status === 200) {
      const data = recoveryRes.body as {
        records?: WhoopRecovery[];
        next_token?: string;
      };
      for (const r of data.records ?? []) {
        const pts = normalizeWhoopRecovery(r);
        points.push(...pts);
        for (const p of pts) {
          if (p.ts > latestTs) latestTs = p.ts;
        }
      }
    }

    // Fetch sleep records
    const sleepRes = await http.request({
      method: "GET",
      url: `https://api.prod.whoop.com/developer/v1/activity/sleep?start=${since}&limit=25`,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (sleepRes.status === 200) {
      const data = sleepRes.body as {
        records?: WhoopSleep[];
        next_token?: string;
      };
      for (const s of data.records ?? []) {
        const pts = normalizeWhoopSleep(s);
        points.push(...pts);
        for (const p of pts) {
          if (p.ts > latestTs) latestTs = p.ts;
        }
      }
    }

    // Fetch cycle/strain records
    const cycleRes = await http.request({
      method: "GET",
      url: `https://api.prod.whoop.com/developer/v1/cycle?start=${since}&limit=25`,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (cycleRes.status === 200) {
      const data = cycleRes.body as {
        records?: WhoopCycle[];
        next_token?: string;
      };
      for (const c of data.records ?? []) {
        const pts = normalizeWhoopCycle(c);
        points.push(...pts);
        for (const p of pts) {
          if (p.ts > latestTs) latestTs = p.ts;
        }
      }
    }

    return {
      points,
      nextCursor: latestTs !== since ? latestTs : null,
    };
  },
};

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
  id?: number;
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
  if (c.score_state !== "SCORED" || !c.score?.strain) return [];

  const ts = c.start ?? new Date().toISOString();
  const ingestedAt = new Date().toISOString();

  return [
    {
      id: makeMetricId({ source: "whoop", metric: "strain", ts, dims: {} }),
      source: "whoop",
      metric: "strain",
      value: c.score.strain,
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
