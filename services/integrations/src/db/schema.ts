/**
 * SQLite schema (DDL) for @jarvis/integrations.
 *
 * Tables:
 *   metric_points       — time-series data (idempotent upsert on id)
 *   cursors             — per (source, stream) high-water marks
 *   sync_runs           — ETL run log + health
 *   calendar_events     — local mirror of Google Calendar events
 *   todos               — built-in todo store
 *   calendar_sync_tokens — per-calendar incremental sync tokens
 */

export const DDL: string[] = [
  // ── metric_points ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS metric_points (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    metric          TEXT NOT NULL,
    value           REAL NOT NULL,
    unit            TEXT NOT NULL,
    ts              TEXT NOT NULL,
    dims            TEXT NOT NULL DEFAULT '{}',
    ingested_at     TEXT NOT NULL,
    adapter_version TEXT NOT NULL DEFAULT '1'
  )`,

  `CREATE INDEX IF NOT EXISTS idx_mp_metric_ts
    ON metric_points (metric, ts)`,

  `CREATE INDEX IF NOT EXISTS idx_mp_source_metric
    ON metric_points (source, metric)`,

  // ── cursors ───────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS cursors (
    source      TEXT NOT NULL,
    stream      TEXT NOT NULL,
    high_water  TEXT NOT NULL,
    page_token  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (source, stream)
  )`,

  // ── sync_runs ─────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id             TEXT PRIMARY KEY,
    source         TEXT NOT NULL,
    stream         TEXT NOT NULL,
    trigger        TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    status         TEXT NOT NULL DEFAULT 'running',
    points_written INTEGER NOT NULL DEFAULT 0,
    pages_fetched  INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    cursor_before  TEXT,
    cursor_after   TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sync_runs_source
    ON sync_runs (source, started_at)`,

  // ── calendar_events ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS calendar_events (
    calendar_id         TEXT NOT NULL,
    id                  TEXT NOT NULL,
    etag                TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL DEFAULT 'confirmed',
    summary             TEXT NOT NULL DEFAULT '',
    description         TEXT,
    location            TEXT,
    start_json          TEXT NOT NULL,
    end_json            TEXT NOT NULL,
    all_day             INTEGER NOT NULL DEFAULT 0,
    recurrence          TEXT,
    recurring_event_id  TEXT,
    original_start_time TEXT,
    attendees           TEXT NOT NULL DEFAULT '[]',
    organizer           TEXT,
    created             TEXT NOT NULL,
    updated             TEXT NOT NULL,
    synced_at           TEXT NOT NULL,
    PRIMARY KEY (calendar_id, id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_cal_events_start
    ON calendar_events (calendar_id, start_json)`,

  // ── calendar_sync_tokens ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS calendar_sync_tokens (
    calendar_id TEXT PRIMARY KEY,
    sync_token  TEXT,
    updated_at  TEXT NOT NULL
  )`,

  // ── todos ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS todos (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    due           TEXT,
    status        TEXT NOT NULL DEFAULT 'open',
    source        TEXT NOT NULL DEFAULT 'user',
    links         TEXT NOT NULL DEFAULT '[]',
    recurrence    TEXT,
    snoozed_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    completed_at  TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_todos_status_due
    ON todos (status, due)`,
];

export function applySchema(db: import("node:sqlite").DatabaseSync): void {
  for (const stmt of DDL) {
    db.exec(stmt);
  }
}
