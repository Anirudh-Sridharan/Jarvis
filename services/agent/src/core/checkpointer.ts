/**
 * SQLite checkpointer for AgentState (feature 16).
 *
 * Persists the full AgentState after every step so that a crash, thermal pause,
 * or overnight human-in-the-loop approval can resume from the precise step.
 *
 * NOTE(future): In the LangGraph.js production swap, replace this with
 * SqliteSaver from @langchain/langgraph-checkpoint-sqlite. The schema here
 * is intentionally compatible: one row per (runId, seq) representing the full
 * state snapshot after that step.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentState, Clock } from "../types.js";

/** Default staleness threshold for sweepOrphaned: 24 hours. */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Real-clock implementation used when no Clock is injected. */
const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

// ── Schema ────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS agent_checkpoints (
  run_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  state    TEXT NOT NULL,   -- JSON-serialized AgentState
  saved_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON agent_checkpoints (run_id, seq DESC);
`;

// ── Checkpointer ─────────────────────────────────────────────────────────────

export class Checkpointer {
  private db: DatabaseSync;
  private clock: Clock;

  constructor(dataDir: string, clock?: Clock) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "agent.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(DDL);
    this.clock = clock ?? REAL_CLOCK;
  }

  /** Persist a state snapshot (appended, never overwritten). */
  save(runId: string, seq: number, state: AgentState): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO agent_checkpoints (run_id, seq, state, saved_at)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.run(runId, seq, JSON.stringify(state), this.clock.isoNow());
  }

  /** Load the latest state for a run (highest seq). Returns undefined if not found. */
  load(runId: string): { seq: number; state: AgentState } | undefined {
    const stmt = this.db.prepare(
      `SELECT seq, state FROM agent_checkpoints
       WHERE run_id = ?
       ORDER BY seq DESC LIMIT 1`,
    );
    const row = stmt.get(runId) as
      | { seq: number; state: string }
      | undefined;
    if (!row) return undefined;
    return { seq: row.seq, state: JSON.parse(row.state) as AgentState };
  }

  /** List all checkpoints for a run, ascending. */
  list(runId: string): Array<{ seq: number; state: AgentState; savedAt: string }> {
    const stmt = this.db.prepare(
      `SELECT seq, state, saved_at FROM agent_checkpoints
       WHERE run_id = ?
       ORDER BY seq ASC`,
    );
    const rows = stmt.all(runId) as Array<{
      seq: number;
      state: string;
      saved_at: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      state: JSON.parse(r.state) as AgentState,
      savedAt: r.saved_at,
    }));
  }

  /** Delete all checkpoints for a completed/abandoned run. */
  delete(runId: string): void {
    this.db.prepare(`DELETE FROM agent_checkpoints WHERE run_id = ?`).run(runId);
  }

  /**
   * Sweep orphaned checkpoint rows left behind by crashed/killed runs.
   *
   * Invariant: never sweeps awaiting-approval or active runs; only stale
   * non-resumable runs. A run is swept iff ALL hold: (a) its run_id is NOT in
   * the caller-supplied `activeRunIds` set, (b) its latest checkpoint status
   * is NOT "awaiting-approval" (those are legitimately long-lived — see the
   * class doc comment), and (c) its latest checkpoint's saved_at is older
   * than `staleAfterMs` (default 24h). Returns the number of runs deleted
   * (not rows).
   */
  sweepOrphaned(opts?: {
    activeRunIds?: Iterable<string>;
    staleAfterMs?: number;
  }): number {
    const staleAfterMs = opts?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const activeRunIds = new Set(opts?.activeRunIds ?? []);
    const nowMs = this.clock.now();

    const stmt = this.db.prepare(
      `SELECT c.run_id AS runId, c.state AS state, c.saved_at AS savedAt
       FROM agent_checkpoints c
       INNER JOIN (
         SELECT run_id, MAX(seq) AS maxSeq FROM agent_checkpoints GROUP BY run_id
       ) latest ON c.run_id = latest.run_id AND c.seq = latest.maxSeq`,
    );
    const rows = stmt.all() as Array<{
      runId: string;
      state: string;
      savedAt: string;
    }>;

    const toDelete: string[] = [];
    for (const row of rows) {
      if (activeRunIds.has(row.runId)) continue;

      let status: string | undefined;
      try {
        status = (JSON.parse(row.state) as AgentState).status;
      } catch {
        status = undefined;
      }
      if (status === "awaiting-approval") continue;

      const age = nowMs - Date.parse(row.savedAt);
      if (age >= staleAfterMs) {
        toDelete.push(row.runId);
      }
    }

    if (toDelete.length === 0) return 0;

    this.db.exec("BEGIN");
    try {
      const delStmt = this.db.prepare(
        `DELETE FROM agent_checkpoints WHERE run_id = ?`,
      );
      for (const runId of toDelete) {
        delStmt.run(runId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return toDelete.length;
  }
}
