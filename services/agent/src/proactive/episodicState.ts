/**
 * Episodic state persistence (feature 19).
 *
 * Stores per-trigger state between runs: last decision, open follow-ups,
 * condition crossing metadata, recent run history refs.
 *
 * This is what makes proactive actions context-aware rather than dumb scripts:
 * the scheduler loads this before waking the agent so it knows what happened
 * last time this trigger fired.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EpisodicState } from "../types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS episodic_state (
  trigger_id  TEXT PRIMARY KEY,
  state       TEXT NOT NULL,  -- JSON
  updated_at  TEXT NOT NULL
);
`;

const MAX_HISTORY_REFS = 20;

export class EpisodicStateStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "episodic.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(DDL);
  }

  read(triggerId: string): EpisodicState {
    const row = this.db
      .prepare(`SELECT state FROM episodic_state WHERE trigger_id = ?`)
      .get(triggerId) as { state: string } | undefined;

    if (!row) {
      return {
        triggerId,
        openFollowUps: [],
        runHistoryRefs: [],
        updatedAt: new Date().toISOString(),
      };
    }

    return JSON.parse(row.state) as EpisodicState;
  }

  write(triggerId: string, state: EpisodicState): void {
    // Bound the history refs
    const bounded: EpisodicState = {
      ...state,
      runHistoryRefs: state.runHistoryRefs.slice(-MAX_HISTORY_REFS),
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO episodic_state (trigger_id, state, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(triggerId, JSON.stringify(bounded), bounded.updatedAt);
  }

  /**
   * Add a run ref to the history, trim to MAX_HISTORY_REFS.
   */
  addRunRef(triggerId: string, runId: string): void {
    const state = this.read(triggerId);
    state.runHistoryRefs = [...state.runHistoryRefs, runId].slice(-MAX_HISTORY_REFS);
    this.write(triggerId, state);
  }

  /**
   * Update condition state (for debounce/cooldown tracking).
   */
  updateConditionState(
    triggerId: string,
    update: NonNullable<EpisodicState["conditionState"]>,
  ): void {
    const state = this.read(triggerId);
    state.conditionState = { ...state.conditionState, ...update };
    this.write(triggerId, state);
  }
}
