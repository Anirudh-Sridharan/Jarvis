/**
 * Deterministic scheduler for connector sync runs.
 *
 * Uses an injected Clock for testability.
 * Each source has a configured cron expression; the scheduler checks
 * which connectors are due on each tick and returns them.
 *
 * Jitter: adds a per-source pseudo-random offset (based on source name hash)
 * to prevent thundering-herd when multiple connectors share the same schedule.
 *
 * SyncRun records are persisted to the database.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CalendarEvent, Clock, Connector, Cursor, HttpClient, TokenStore, SyncRun, SourceId } from "../types.js";
import { MetricStore } from "./metricStore.js";
import { newId, toJson, fromJson } from "../db/database.js";

/** Where ConnectorSyncResult.events land (CalendarMirror in production). */
export interface EventSink {
  upsertEvent(event: CalendarEvent): void;
  tombstoneEvent(calendarId: string, eventId: string): void;
}

export interface SchedulerConfig {
  jitterMaxMs?: number;
  /** Persists calendar events from sync results. Without it, events are dropped. */
  eventSink?: EventSink;
}

const DEFAULT_JITTER_MAX_MS = 5 * 60 * 1000; // 5 minutes max jitter

/** Parse a cron expression and check if it's due given the last run time and current time. */
export function isDue(
  cronExpr: string,
  lastRunAt: number | null,
  nowMs: number,
  sourceId: SourceId,
  jitterMaxMs: number = DEFAULT_JITTER_MAX_MS
): boolean {
  // Deterministic per-source jitter offset
  const jitterMs = sourceJitter(sourceId, jitterMaxMs);

  // Simple cron: supports '*/N * * * *' (every N minutes),
  // 'M * * * *' (hourly at minute M), and 'M H * * *' (daily at H:M UTC).
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour] = parts;

  // '*/N * * * *' — interval schedule: due every N minutes since the last run.
  if (minute?.startsWith("*/")) {
    const intervalMin = parseInt(minute.slice(2), 10);
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) return false;
    if (lastRunAt === null) return true;
    return nowMs - lastRunAt >= intervalMin * 60_000;
  }

  const targetMin = parseInt(minute ?? "0", 10);
  if (Number.isNaN(targetMin)) return false;

  // 'M * * * *' — hourly at minute M (+ per-source jitter).
  if (hour === "*") {
    const hourStart = new Date(nowMs);
    hourStart.setUTCMinutes(0, 0, 0);
    const hourTargetMs = hourStart.getTime() + targetMin * 60_000 + jitterMs;
    if (nowMs < hourTargetMs) return false;
    if (lastRunAt === null) return true;
    return lastRunAt < hourTargetMs;
  }

  const targetHour = parseInt(hour ?? "5", 10);
  if (Number.isNaN(targetHour)) return false;

  // The target time for today (UTC), adjusted for jitter
  const todayTarget = new Date(nowMs);
  todayTarget.setUTCHours(targetHour, targetMin, 0, 0);
  const targetMs = todayTarget.getTime() + jitterMs;

  // If it's before the target time today, not due
  if (nowMs < targetMs) return false;

  // If no prior run, it's due
  if (lastRunAt === null) return true;

  // Check if the last run was before today's target time
  // i.e., the window [targetMs, targetMs + 1 day) has not been covered
  const nextTarget = targetMs + 24 * 60 * 60 * 1000;
  return lastRunAt < targetMs && nowMs >= targetMs && nowMs < nextTarget;
}

function sourceJitter(sourceId: SourceId, maxMs: number): number {
  const hash = createHash("sha256").update(sourceId).digest();
  const byte0 = hash[0] ?? 0;
  const byte1 = hash[1] ?? 0;
  const val = (byte0 * 256 + byte1) / 65535;
  return Math.floor(val * maxMs);
}

export class Scheduler {
  private lastRunAt = new Map<SourceId, number>();

  constructor(
    private db: DatabaseSync,
    private metricStore: MetricStore,
    private clock: Clock,
    private config: SchedulerConfig = {}
  ) {}

  /** Check which connectors are due and return them. */
  getDueConnectors(connectors: Connector[]): Connector[] {
    const now = this.clock.now();
    const jitterMax = this.config.jitterMaxMs ?? DEFAULT_JITTER_MAX_MS;

    return connectors.filter((c) => {
      const last = this.getLastSuccessfulRun(c.id);
      return isDue(c.schedule, last, now, c.id, jitterMax);
    });
  }

  /** Execute a sync run for a connector. Records the run in the database. */
  async runSync(
    connector: Connector,
    http: HttpClient,
    tokenStore: TokenStore,
    trigger: SyncRun["trigger"] = "schedule"
  ): Promise<SyncRun> {
    const runId = newId();
    const startedAt = new Date(this.clock.now()).toISOString();
    const stream = `${connector.id}.sync`;

    // Load cursor
    const cursor = this.loadCursor(connector.id, stream);

    // Create run record
    const run: SyncRun = {
      id: runId,
      source: connector.id,
      stream,
      trigger,
      startedAt,
      status: "running",
      pointsWritten: 0,
      pagesFetched: 0,
      cursorBefore: cursor ? cursor.highWater : null,
      cursorAfter: null,
    };

    this.saveRun(run);

    try {
      const result = await connector.sync(cursor, http, tokenStore);

      let written = 0;
      if (result.points.length > 0) {
        const { inserted, updated } = this.metricStore.upsertSeries(result.points);
        written = inserted + updated;
      }

      // Mirror calendar events BEFORE advancing the cursor (cursor discipline:
      // a syncToken must never advance past events that weren't persisted).
      const sink = this.config.eventSink;
      if (sink) {
        for (const event of result.events ?? []) {
          if (event.status === "cancelled") {
            sink.tombstoneEvent(event.calendarId, event.id);
          } else {
            sink.upsertEvent(event);
          }
        }
      }

      // Advance cursor only after successful write
      if (result.nextCursor !== null) {
        this.saveCursor({
          source: connector.id,
          stream,
          highWater: result.nextCursor,
          updatedAt: new Date(this.clock.now()).toISOString(),
        });
      }

      const finishedAt = new Date(this.clock.now()).toISOString();
      const finishedRun: SyncRun = {
        ...run,
        finishedAt,
        status: "ok",
        pointsWritten: written,
        pagesFetched: 1,
        cursorAfter: result.nextCursor,
      };

      this.saveRun(finishedRun);
      this.lastRunAt.set(connector.id, this.clock.now());
      return finishedRun;
    } catch (err) {
      const finishedAt = new Date(this.clock.now()).toISOString();
      const errorRun: SyncRun = {
        ...run,
        finishedAt,
        status: "error",
        error: {
          code: "SYNC_ERROR",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      };
      this.saveRun(errorRun);
      return errorRun;
    }
  }

  private getLastSuccessfulRun(source: SourceId): number | null {
    // Check in-memory cache first
    const cached = this.lastRunAt.get(source);
    if (cached !== undefined) return cached;

    // Fall back to database
    const row = this.db
      .prepare(
        `SELECT started_at FROM sync_runs
         WHERE source = ? AND status = 'ok'
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(source) as { started_at: string } | undefined;

    if (!row) return null;
    return new Date(row.started_at).getTime();
  }

  private loadCursor(source: SourceId, stream: string): Cursor | null {
    const row = this.db
      .prepare(
        `SELECT source, stream, high_water, page_token, updated_at
         FROM cursors WHERE source = ? AND stream = ?`
      )
      .get(source, stream) as
      | {
          source: string;
          stream: string;
          high_water: string;
          page_token: string | null;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;
    return {
      source: row.source as SourceId,
      stream: row.stream,
      highWater: row.high_water,
      pageToken: row.page_token,
      updatedAt: row.updated_at,
    };
  }

  private saveCursor(cursor: Omit<Cursor, "pageToken"> & { pageToken?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO cursors (source, stream, high_water, page_token, updated_at)
         VALUES (:source, :stream, :high_water, :page_token, :updated_at)
         ON CONFLICT(source, stream) DO UPDATE SET
           high_water = excluded.high_water,
           page_token = excluded.page_token,
           updated_at = excluded.updated_at`
      )
      .run({
        source: cursor.source,
        stream: cursor.stream,
        high_water: cursor.highWater,
        page_token: cursor.pageToken ?? null,
        updated_at: cursor.updatedAt,
      });
  }

  private saveRun(run: SyncRun): void {
    this.db
      .prepare(
        `INSERT INTO sync_runs
           (id, source, stream, trigger, started_at, finished_at, status,
            points_written, pages_fetched, error, cursor_before, cursor_after)
         VALUES
           (:id, :source, :stream, :trigger, :started_at, :finished_at, :status,
            :points_written, :pages_fetched, :error, :cursor_before, :cursor_after)
         ON CONFLICT(id) DO UPDATE SET
           finished_at    = excluded.finished_at,
           status         = excluded.status,
           points_written = excluded.points_written,
           pages_fetched  = excluded.pages_fetched,
           error          = excluded.error,
           cursor_after   = excluded.cursor_after`
      )
      .run({
        id: run.id,
        source: run.source,
        stream: run.stream,
        trigger: run.trigger,
        started_at: run.startedAt,
        finished_at: run.finishedAt ?? null,
        status: run.status,
        points_written: run.pointsWritten,
        pages_fetched: run.pagesFetched,
        error: run.error ? toJson(run.error) : null,
        cursor_before: run.cursorBefore ?? null,
        cursor_after: run.cursorAfter ?? null,
      });
  }

  listRuns(source?: SourceId, limit = 50): SyncRun[] {
    let rows: Record<string, unknown>[];
    if (source) {
      rows = this.db
        .prepare(
          `SELECT * FROM sync_runs WHERE source = ? ORDER BY started_at DESC LIMIT ?`
        )
        .all(source, limit) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[];
    }
    return rows.map(rowToRun);
  }
}

function rowToRun(row: Record<string, unknown>): SyncRun {
  return {
    id: row["id"] as string,
    source: row["source"] as SourceId,
    stream: row["stream"] as string,
    trigger: row["trigger"] as SyncRun["trigger"],
    startedAt: row["started_at"] as string,
    finishedAt: row["finished_at"] as string | undefined,
    status: row["status"] as SyncRun["status"],
    pointsWritten: row["points_written"] as number,
    pagesFetched: row["pages_fetched"] as number,
    error: fromJson<SyncRun["error"]>(row["error"] as string | null, null),
    cursorBefore: row["cursor_before"] as string | null | undefined,
    cursorAfter: row["cursor_after"] as string | null | undefined,
  };
}
