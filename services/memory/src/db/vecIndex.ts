/**
 * VecIndex — optional sqlite-vec acceleration for vector search.
 *
 * When the sqlite-vec loadable extension is available, episode/fact embeddings
 * are mirrored into a `vec0` virtual table and KNN runs in C (exact, cosine)
 * instead of the brute-force JS scan that re-parses every embedding's JSON on
 * every query — the real bottleneck at scale.
 *
 * Everything degrades gracefully: if the extension cannot load (binary missing
 * for the platform, older Node, etc.), `isAvailable()` stays false and the store
 * keeps using brute-force cosine. The vec0 table is a *mirror* — the
 * episodes/facts embedding columns remain the source of truth — kept in sync by
 * dual-writes (upsert) plus reconcile() at open and after consolidation.
 *
 * vec0 KNN is exact (not approximate) in sqlite-vec 0.1.x, so results match the
 * brute-force cosine path; this is a transparent accelerator, not a behavior
 * change. The cosine distance it returns maps to similarity as `1 - distance`.
 */

import type { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { fromJson } from "./database.js";

const TABLE = "vec_nodes";

/** Minimal shape sqlite-vec's load() needs — node:sqlite satisfies it at runtime. */
interface ExtensionDb {
  loadExtension(file: string, entrypoint?: string): void;
}

export interface VecHit {
  /** Prefixed node id, e.g. "ep:<id>" or "fact:<id>". */
  id: string;
  /** Cosine similarity in [-1, 1] (1 - cosine distance). */
  score: number;
}

/** Pack a JS number[] into the little-endian Float32 bytes sqlite-vec expects. */
function toFloat32Bytes(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

export class VecIndex {
  private available = false;
  private ensured = false;

  constructor(private readonly db: DatabaseSync) {}

  /** Attempt to load sqlite-vec. Safe no-op (returns false) on any failure. */
  tryLoad(): boolean {
    try {
      loadSqliteVec(this.db as unknown as ExtensionDb);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** True only when the extension loaded AND the mirror table exists. */
  isAvailable(): boolean {
    return this.available && this.tableExists();
  }

  private tableExists(): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(TABLE);
    return row != null;
  }

  /** Create the vec0 mirror table at the given dimension (once). */
  private ensureTable(dim: number): void {
    if (this.ensured || !Number.isInteger(dim) || dim <= 0) return;
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING vec0(` +
        `node_id TEXT PRIMARY KEY, embedding FLOAT[${dim}] distance_metric=cosine)`,
    );
    this.ensured = true;
  }

  /** Mirror one node's embedding (upsert). No-op when the extension is absent. */
  upsert(id: string, embedding: number[]): void {
    if (!this.available || embedding.length === 0) return;
    this.ensureTable(embedding.length);
    const bytes = toFloat32Bytes(embedding);
    this.db.prepare(`DELETE FROM ${TABLE} WHERE node_id = ?`).run(id);
    this.db.prepare(`INSERT INTO ${TABLE}(node_id, embedding) VALUES (?, ?)`).run(id, bytes);
  }

  /** Exact cosine KNN. Returns up to `k` prefixed ids with similarity scores. */
  search(query: number[], k: number): VecHit[] {
    if (!this.isAvailable() || query.length === 0 || k <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT node_id, distance FROM ${TABLE} ` +
          `WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(toFloat32Bytes(query), k) as unknown as { node_id: string; distance: number }[];
    return rows.map((r) => ({ id: r.node_id, score: 1 - r.distance }));
  }

  /**
   * Diff-based sync: insert any episode/fact embedding missing from the mirror.
   * Idempotent and cheap when already in sync — safe to call on open and after
   * each consolidation pass (catches facts written via non-upsert paths).
   */
  reconcile(): void {
    if (!this.available) return;

    const have = new Set<string>();
    if (this.tableExists()) {
      this.ensured = true;
      const rows = this.db
        .prepare(`SELECT node_id FROM ${TABLE}`)
        .all() as unknown as { node_id: string }[];
      for (const r of rows) have.add(r.node_id);
    }

    const mirror = (prefix: string, table: "episodes" | "facts") => {
      const rows = this.db
        .prepare(`SELECT id, embedding FROM ${table} WHERE embedding IS NOT NULL`)
        .all() as unknown as { id: string; embedding: string }[];
      for (const row of rows) {
        const id = `${prefix}:${row.id}`;
        if (have.has(id)) continue;
        const vec = fromJson<number[]>(row.embedding, []);
        if (vec.length) this.upsert(id, vec);
      }
    };

    mirror("ep", "episodes");
    mirror("fact", "facts");
  }
}
