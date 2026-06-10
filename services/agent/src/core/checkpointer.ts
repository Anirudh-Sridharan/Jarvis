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
import type { AgentState } from "../types.js";

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

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "agent.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(DDL);
  }

  /** Persist a state snapshot (appended, never overwritten). */
  save(runId: string, seq: number, state: AgentState): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO agent_checkpoints (run_id, seq, state, saved_at)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.run(runId, seq, JSON.stringify(state), new Date().toISOString());
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
}
