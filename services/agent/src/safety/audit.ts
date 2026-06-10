/**
 * Immutable hash-chained audit log (feature 17).
 *
 * Every entry hashes the previous entry's hash, forming a tamper-evident chain.
 * Stored in SQLite for indexed lookups + a serialized JSON form for chain verification.
 *
 * Chain structure:
 *   entry[0].prevHash = GENESIS ("0"*64)
 *   entry[n].prevHash = entry[n-1].hash
 *   entry[n].hash = sha256(seq|ts|kind|actionId|runId|payload|prevHash)
 *
 * Tampering with any entry breaks the prevHash linkage — verifyChain() detects this.
 *
 * NOTE(future): For production, add an external periodic hash anchor (e.g., commit
 * the chain tip hash to a git repo or a public timestamping service) for stronger
 * guarantees against retroactive rewriting.
 */

import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, Clock } from "../types.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq       INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  action_id TEXT NOT NULL,
  run_id    TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log (run_id);
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit_log (kind);
`;

const GENESIS = "0".repeat(64);

// ── Hash helpers ──────────────────────────────────────────────────────────────

function hashEntry(e: Omit<AuditEntry, "hash">): string {
  const canonical =
    `${e.seq}|${e.ts}|${e.kind}|${e.actionId}|${e.runId}|` +
    JSON.stringify(e.payload) +
    `|${e.prevHash}`;
  return createHash("sha256").update(canonical).digest("hex");
}

// ── AuditLog ──────────────────────────────────────────────────────────────────

export class AuditLog {
  private db: DatabaseSync;
  private latestHash: string = GENESIS;
  private latestSeq: number = -1;
  private initialized = false;

  constructor(
    dataDir: string,
    private clock?: Clock,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "audit.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(DDL);
    this.loadTail();
  }

  private loadTail(): void {
    const row = this.db
      .prepare(
        `SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
      )
      .get() as { seq: number; hash: string } | undefined;

    if (row) {
      this.latestSeq = row.seq;
      this.latestHash = row.hash;
    }
    this.initialized = true;
  }

  /**
   * Append an immutable entry to the audit log.
   * Returns the full entry including seq and hash.
   */
  append(
    e: Pick<AuditEntry, "kind" | "actionId" | "runId" | "payload">,
  ): AuditEntry {
    const seq = this.latestSeq + 1;
    const ts = this.clock ? this.clock.isoNow() : new Date().toISOString();
    const prevHash = this.latestHash;

    const base: Omit<AuditEntry, "hash"> = {
      seq,
      ts,
      kind: e.kind,
      actionId: e.actionId,
      runId: e.runId,
      payload: e.payload,
      prevHash,
    };
    const hash = hashEntry(base);
    const entry: AuditEntry = { ...base, hash };

    this.db
      .prepare(
        `INSERT INTO audit_log (seq, ts, kind, action_id, run_id, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.seq,
        entry.ts,
        entry.kind,
        entry.actionId,
        entry.runId,
        JSON.stringify(entry.payload),
        entry.prevHash,
        entry.hash,
      );

    this.latestSeq = seq;
    this.latestHash = hash;

    return entry;
  }

  /**
   * Verify the hash chain integrity.
   * Returns { ok: true } or { ok: false, brokenAt: seq } for the first broken link.
   */
  verifyChain(): { ok: boolean; brokenAt?: number } {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, kind, action_id, run_id, payload, prev_hash, hash
         FROM audit_log ORDER BY seq ASC`,
      )
      .all() as Array<{
      seq: number;
      ts: string;
      kind: string;
      action_id: string;
      run_id: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }>;

    let prevHash = GENESIS;
    for (const row of rows) {
      const entry: Omit<AuditEntry, "hash"> = {
        seq: row.seq,
        ts: row.ts,
        kind: row.kind as AuditEntry["kind"],
        actionId: row.action_id,
        runId: row.run_id,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        prevHash: row.prev_hash,
      };

      if (row.prev_hash !== prevHash) {
        return { ok: false, brokenAt: row.seq };
      }

      const expectedHash = hashEntry(entry);
      if (expectedHash !== row.hash) {
        return { ok: false, brokenAt: row.seq };
      }

      prevHash = row.hash;
    }

    return { ok: true };
  }

  /**
   * Read all entries for a run (ascending order).
   */
  forRun(runId: string): AuditEntry[] {
    const rows = this.db
      .prepare(
        `SELECT seq, ts, kind, action_id, run_id, payload, prev_hash, hash
         FROM audit_log WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(runId) as Array<{
      seq: number;
      ts: string;
      kind: string;
      action_id: string;
      run_id: string;
      payload: string;
      prev_hash: string;
      hash: string;
    }>;

    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      kind: r.kind as AuditEntry["kind"],
      actionId: r.action_id,
      runId: r.run_id,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      prevHash: r.prev_hash,
      hash: r.hash,
    }));
  }

  /** Total entry count. */
  get count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM audit_log`)
      .get() as { n: number };
    return row.n;
  }
}
