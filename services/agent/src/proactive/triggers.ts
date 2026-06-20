/**
 * Trigger registry and persistence (feature 19).
 *
 * Stores Trigger rows in SQLite and manages their lifecycle.
 * Three trigger types:
 *   - cron: time-based, DST-aware
 *   - event: fired by internal bus events
 *   - condition: threshold predicate evaluated on a poll
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Trigger, TriggerStatus, TriggerKind } from "../types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS triggers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config      TEXT NOT NULL,  -- JSON (cron/event/condition/action/tags/catchUp)
  status      TEXT NOT NULL DEFAULT 'scheduled',
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_id TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers (enabled, kind);
`;

interface TriggerRow {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  config: string;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export class TriggerStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "triggers.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(DDL);
  }

  create(
    trigger: Omit<Trigger, "id" | "createdAt" | "updatedAt" | "status">,
    now: string,
  ): Trigger {
    const id = randomUUID();
    const t: Trigger = {
      ...trigger,
      id,
      status: "scheduled",
      createdAt: now,
      updatedAt: now,
    };
    this._insert(t);
    return t;
  }

  /**
   * Serialize the variable-shape parts of a trigger into the `config` JSON
   * column. The fixed columns (id, name, kind, status, timestamps, run refs)
   * are stored directly; everything kind-specific lives here as one blob so the
   * schema stays stable as new trigger shapes are added.
   */
  private serializeConfig(t: Trigger): string {
    return JSON.stringify({
      cron: t.cron,
      event: t.event,
      condition: t.condition,
      action: t.action,
      tags: t.tags,
      catchUp: t.catchUp,
    });
  }

  private _insert(t: Trigger): void {
    const config = this.serializeConfig(t);
    this.db
      .prepare(
        `INSERT INTO triggers (id, name, kind, enabled, config, status, next_run_at, last_run_at, last_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.name,
        t.kind,
        t.enabled ? 1 : 0,
        config,
        t.status,
        t.nextRunAt ?? null,
        t.lastRunAt ?? null,
        t.lastRunId ?? null,
        t.createdAt,
        t.updatedAt,
      );
  }

  get(id: string): Trigger | undefined {
    const row = this.db
      .prepare(`SELECT * FROM triggers WHERE id = ?`)
      .get(id) as TriggerRow | undefined;
    return row ? this._rowToTrigger(row) : undefined;
  }

  list(filter?: { enabled?: boolean; kind?: TriggerKind }): Trigger[] {
    let sql = `SELECT * FROM triggers WHERE 1=1`;
    const params: unknown[] = [];
    if (filter?.enabled !== undefined) {
      sql += ` AND enabled = ?`;
      params.push(filter.enabled ? 1 : 0);
    }
    if (filter?.kind) {
      sql += ` AND kind = ?`;
      params.push(filter.kind);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (this.db.prepare(sql).all(...(params as any[])) as unknown) as TriggerRow[];
    return rows.map((r) => this._rowToTrigger(r));
  }

  update(id: string, updates: Partial<Trigger>, now: string): void {
    const existing = this.get(id);
    if (!existing) return;

    const merged = { ...existing, ...updates, updatedAt: now };
    const config = this.serializeConfig(merged);

    this.db
      .prepare(
        `UPDATE triggers SET name=?, kind=?, enabled=?, config=?, status=?,
         next_run_at=?, last_run_at=?, last_run_id=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        merged.name,
        merged.kind,
        merged.enabled ? 1 : 0,
        config,
        merged.status,
        merged.nextRunAt ?? null,
        merged.lastRunAt ?? null,
        merged.lastRunId ?? null,
        merged.updatedAt,
        id,
      );
  }

  setStatus(id: string, status: TriggerStatus, now: string): void {
    this.db
      .prepare(`UPDATE triggers SET status=?, updated_at=? WHERE id=?`)
      .run(status, now, id);
  }

  bumpLastRun(id: string, runId: string, nextRunAt: string | undefined, now: string): void {
    this.db
      .prepare(
        `UPDATE triggers SET last_run_at=?, last_run_id=?, next_run_at=?, updated_at=? WHERE id=?`,
      )
      .run(now, runId, nextRunAt ?? null, now, id);
  }

  disable(id: string, now: string): void {
    this.db
      .prepare(`UPDATE triggers SET enabled=0, status='disabled', updated_at=? WHERE id=?`)
      .run(now, id);
  }

  private _rowToTrigger(row: TriggerRow): Trigger {
    const config = JSON.parse(row.config) as {
      cron?: Trigger["cron"];
      event?: Trigger["event"];
      condition?: Trigger["condition"];
      action: Trigger["action"];
      tags: string[];
      catchUp: Trigger["catchUp"];
    };

    return {
      id: row.id,
      name: row.name,
      kind: row.kind as TriggerKind,
      enabled: row.enabled === 1,
      cron: config.cron,
      event: config.event,
      condition: config.condition,
      action: config.action,
      tags: config.tags,
      catchUp: config.catchUp,
      status: row.status as TriggerStatus,
      nextRunAt: row.next_run_at ?? undefined,
      lastRunAt: row.last_run_at ?? undefined,
      lastRunId: row.last_run_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
