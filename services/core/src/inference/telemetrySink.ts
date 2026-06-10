/**
 * Telemetry sink (closes TODO(phase3: feature dashboard) in telemetry.ts):
 * durable SQLite record of routing decisions and per-turn latency metrics,
 * plus cheap aggregates for the dashboard / GET /telemetry.
 *
 * Writes are synchronous and tiny (one row per chat turn — single-user box);
 * a small in-memory ring keeps recent() allocation-free on the hot path.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoutingDecision } from "./types.js";
import type { TurnMetrics } from "./telemetry.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'routing' | 'turn'
  target TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reason TEXT,                     -- routing only
  est_prompt_tokens INTEGER,       -- routing only
  ttft_ms INTEGER,                 -- turn only
  tokens INTEGER,                  -- turn only
  duration_ms INTEGER,             -- turn only
  fallback INTEGER                 -- turn only (0/1)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry_turns(ts);
`;

const RING_SIZE = 200;

export interface TelemetryTurnRow {
  ts: string;
  kind: "routing" | "turn";
  target: string;
  modelId: string;
  reason?: string;
  estPromptTokens?: number;
  ttftMs?: number;
  tokens?: number;
  durationMs?: number;
  fallback?: boolean;
}

export interface TelemetrySummary {
  sinceHours: number;
  turns: number;
  avgTtftMs: number | null;
  avgTokensPerSec: number | null;
  byTarget: Record<string, number>;
  fallbackTurns: number;
}

export class TelemetrySink {
  private readonly ring: TelemetryTurnRow[] = [];

  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
    // Retention: telemetry is operational data, not memory — keep 30 days so
    // the table (and the 15s dashboard poll's scans) never grow unbounded.
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare(`DELETE FROM telemetry_turns WHERE ts < ?`).run(cutoff);
  }

  recordRouting(d: RoutingDecision): void {
    const row: TelemetryTurnRow = {
      ts: new Date().toISOString(),
      kind: "routing",
      target: d.target,
      modelId: d.modelId,
      reason: d.reason,
      estPromptTokens: d.estPromptTokens,
    };
    this.db
      .prepare(
        `INSERT INTO telemetry_turns (ts, kind, target, model_id, reason, est_prompt_tokens)
         VALUES (?, 'routing', ?, ?, ?, ?)`,
      )
      .run(row.ts, row.target, row.modelId, row.reason ?? null, row.estPromptTokens ?? null);
    this.push(row);
  }

  recordTurn(m: TurnMetrics): void {
    const row: TelemetryTurnRow = {
      ts: new Date().toISOString(),
      kind: "turn",
      target: m.target,
      modelId: m.modelId,
      ttftMs: m.ttftMs,
      tokens: m.tokens,
      durationMs: m.durationMs,
      fallback: m.fallbackActive,
    };
    this.db
      .prepare(
        `INSERT INTO telemetry_turns (ts, kind, target, model_id, ttft_ms, tokens, duration_ms, fallback)
         VALUES (?, 'turn', ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.ts, row.target, row.modelId, m.ttftMs, m.tokens, m.durationMs, m.fallbackActive ? 1 : 0);
    this.push(row);
  }

  /** Most recent rows, newest first (ring-buffer fast path). */
  recent(limit = 50): TelemetryTurnRow[] {
    if (this.ring.length >= Math.min(limit, RING_SIZE)) {
      return this.ring.slice(-limit).reverse();
    }
    const rows = this.db
      .prepare(`SELECT * FROM telemetry_turns ORDER BY id DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(dbRowToTurnRow);
  }

  /** Aggregates over completed turns in the trailing window. */
  summary(sinceHours = 24): TelemetrySummary {
    const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    const rows = this.db
      .prepare(`SELECT * FROM telemetry_turns WHERE kind = 'turn' AND ts >= ?`)
      .all(since) as Record<string, unknown>[];

    const byTarget: Record<string, number> = {};
    let ttftSum = 0;
    let ttftCount = 0;
    let tpsSum = 0;
    let tpsCount = 0;
    let fallbackTurns = 0;

    for (const r of rows) {
      const target = r["target"] as string;
      byTarget[target] = (byTarget[target] ?? 0) + 1;
      const ttft = r["ttft_ms"] as number | null;
      if (ttft != null && ttft >= 0) {
        ttftSum += ttft;
        ttftCount++;
      }
      const tokens = r["tokens"] as number | null;
      const duration = r["duration_ms"] as number | null;
      if (tokens != null && duration != null && duration > 0) {
        tpsSum += tokens / (duration / 1000);
        tpsCount++;
      }
      if (r["fallback"] === 1) fallbackTurns++;
    }

    return {
      sinceHours,
      turns: rows.length,
      avgTtftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : null,
      avgTokensPerSec: tpsCount > 0 ? Math.round((tpsSum / tpsCount) * 10) / 10 : null,
      byTarget,
      fallbackTurns,
    };
  }

  private push(row: TelemetryTurnRow): void {
    this.ring.push(row);
    if (this.ring.length > RING_SIZE) this.ring.shift();
  }
}

function dbRowToTurnRow(r: Record<string, unknown>): TelemetryTurnRow {
  return {
    ts: r["ts"] as string,
    kind: r["kind"] as "routing" | "turn",
    target: r["target"] as string,
    modelId: r["model_id"] as string,
    reason: (r["reason"] as string | null) ?? undefined,
    estPromptTokens: (r["est_prompt_tokens"] as number | null) ?? undefined,
    ttftMs: (r["ttft_ms"] as number | null) ?? undefined,
    tokens: (r["tokens"] as number | null) ?? undefined,
    durationMs: (r["duration_ms"] as number | null) ?? undefined,
    fallback: r["fallback"] == null ? undefined : r["fallback"] === 1,
  };
}

/** Open (or create) the durable sink at `<dataDir>/telemetry.sqlite`. */
export function createTelemetrySink(dataDir: string): TelemetrySink {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "telemetry.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  return new TelemetrySink(db);
}
