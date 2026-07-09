/**
 * ImessageStateStore — the leaf's own durable state (imessage.db).
 *
 * This is NEVER chat.db (the macOS Messages database, read-only, out of
 * scope this phase) and NEVER memory.db (@jarvis/memory's bi-temporal
 * knowledge graph) — it is @jarvis/imessage's own, small, single-purpose
 * store, opened via the same openDatabase(dataDir) factory idiom used by
 * @jarvis/memory/@jarvis/integrations/@jarvis/agent's checkpointer.
 *
 * Three safety roles, one table each:
 *   - imessage_watermark:         TXT-07 — last processed chat.db ROWID.
 *     advance-only-after-success is the CALLER's (Plan 09-02's orchestrator)
 *     responsibility; this store only enforces the monotonic guard.
 *   - imessage_sent_fingerprints: TXT-04 — short-TTL echo-guard net.
 *   - imessage_processed_guids:   TXT-06 — GUID-keyed exactly-once tracking.
 *     Never content-keyed: an edited message (same GUID, new text) does not
 *     re-trip anything here — see fingerprint.ts's header for why identity
 *     must never be re-derived from content.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../types.js";

/** Real-clock implementation used when no Clock is injected. */
const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

const DDL = `
CREATE TABLE IF NOT EXISTS imessage_watermark (
  id TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imessage_sent_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_sent_at
  ON imessage_sent_fingerprints (sent_at);
CREATE TABLE IF NOT EXISTS imessage_processed_guids (
  guid TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
`;

const WATERMARK_SINGLETON_ID = "singleton";

export class ImessageStateStore {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(dataDir: string, clock: Clock = REAL_CLOCK) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(
      join(dataDir, "imessage.db"),
      { timeout: 5000 } as unknown as ConstructorParameters<typeof DatabaseSync>[1],
    );
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(DDL);
    this.clock = clock;
  }

  // ── Watermark (TXT-07) ─────────────────────────────────────────────────

  /** Returns the last processed ROWID, or 0 on a fresh database. */
  getWatermark(): number {
    const row = this.db
      .prepare(`SELECT last_rowid FROM imessage_watermark WHERE id = ?`)
      .get(WATERMARK_SINGLETON_ID) as { last_rowid: number } | undefined;
    return row?.last_rowid ?? 0;
  }

  /**
   * Advance the watermark to rowId. Monotonic guard: a rowId at or below
   * the current watermark is a no-op (never moves it backwards). Advancing
   * WHEN to call this is the orchestrator's responsibility (advance only
   * after a successful send) — this store just enforces monotonicity.
   */
  advanceWatermark(rowId: number): void {
    const current = this.getWatermark();
    if (rowId <= current) return;
    this.db
      .prepare(
        `INSERT INTO imessage_watermark (id, last_rowid, updated_at)
         VALUES (:id, :last_rowid, :updated_at)
         ON CONFLICT(id) DO UPDATE SET
           last_rowid = excluded.last_rowid,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: WATERMARK_SINGLETON_ID,
        last_rowid: rowId,
        updated_at: this.clock.isoNow(),
      });
  }

  // ── Sent-message fingerprints (TXT-04) ────────────────────────────────

  /** Record a sent-message fingerprint at the current clock time. */
  recordFingerprint(fingerprint: string, chatId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO imessage_sent_fingerprints (fingerprint, chat_id, sent_at)
         VALUES (?, ?, ?)`,
      )
      .run(fingerprint, chatId, this.clock.now());
  }

  /**
   * True if `fingerprint` was recorded within the last `ttlMs`. Recency is
   * query-time (compares against the current clock), NOT dependent on
   * pruneFingerprints() having been called.
   */
  hasRecentFingerprint(fingerprint: string, ttlMs: number): boolean {
    const cutoff = this.clock.now() - ttlMs;
    const row = this.db
      .prepare(
        `SELECT 1 FROM imessage_sent_fingerprints WHERE fingerprint = ? AND sent_at >= ?`,
      )
      .get(fingerprint, cutoff);
    return row !== undefined;
  }

  /**
   * Physically DELETE fingerprint rows older than ttlMs. This table holds
   * transient operational echo-guard state with a TTL, NOT bi-temporal
   * memory — the facts/journal never-hard-delete invariant does not apply
   * here; hard delete is the correct, intended behavior.
   */
  pruneFingerprints(ttlMs: number): void {
    const cutoff = this.clock.now() - ttlMs;
    this.db
      .prepare(`DELETE FROM imessage_sent_fingerprints WHERE sent_at < ?`)
      .run(cutoff);
  }

  // ── Processed GUIDs (TXT-06) ───────────────────────────────────────────

  /**
   * Record a message as processed, keyed by its immutable GUID (never by
   * content). INSERT OR IGNORE: re-processing the same GUID with a
   * different contentHash (e.g. an edited message) never throws and never
   * overwrites — identity is GUID-keyed, exactly-once.
   */
  markProcessed(guid: string, chatId: string, contentHash: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO imessage_processed_guids (guid, chat_id, content_hash, processed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(guid, chatId, contentHash, this.clock.now());
  }

  /** True if `guid` has already been processed. */
  hasProcessed(guid: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM imessage_processed_guids WHERE guid = ?`)
      .get(guid);
    return row !== undefined;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
