/**
 * SQLite schema (DDL) for the @jarvis/memory temporal knowledge graph.
 *
 * All state is stored in a single SQLite database using node:sqlite (built-in,
 * no native addons).
 *
 * NOTE(future): The temporal KG design here is intentionally modeled on Graphiti
 * (https://github.com/getzep/graphiti). When FalkorDB/Neo4j is available
 * (feature 9 connectors phase), the graph tables below can be swapped to
 * Cypher-based queries while keeping the same TypeScript API.
 */

// ── DDL statements ───────────────────────────────────────────────────────────

export const DDL: string[] = [
  // ── entities ────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
    merged_from TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    text TEXT NOT NULL,
    embedding BLOB,                        -- JSON float array
    ingested_at TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0,
    provenance TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE INDEX IF NOT EXISTS idx_entities_name_type
    ON entities (name, entity_type)`,

  // ── episodes ─────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    embedding BLOB,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',    -- JSON
    entity_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
    derived_fact_ids TEXT NOT NULL DEFAULT '[]',
    importance INTEGER NOT NULL DEFAULT 5,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0,
    provenance TEXT NOT NULL DEFAULT '{}',
    consolidation_pending INTEGER NOT NULL DEFAULT 1
  )`,

  `CREATE INDEX IF NOT EXISTS idx_episodes_occurred_at ON episodes (occurred_at)`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_consolidation ON episodes (consolidation_pending)`,

  // ── facts (bi-temporal) ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object_id TEXT,
    object_literal TEXT,
    text TEXT NOT NULL,
    embedding BLOB,
    -- BI-TEMPORAL MODEL
    -- Event time (when was this true in the world?)
    valid_from TEXT NOT NULL,
    valid_to TEXT,                         -- NULL = currently true
    -- System time (when did Jarvis learn/unlearn this?)
    ingested_at TEXT NOT NULL,
    invalidated_at TEXT,                   -- NULL = live
    invalidated_by TEXT,                   -- factId that supersedes
    supersedes TEXT,                       -- factId this one replaced
    importance INTEGER NOT NULL DEFAULT 5,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0,
    provenance TEXT NOT NULL DEFAULT '{}',
    source_trust REAL NOT NULL DEFAULT 0.5,
    -- User-confirmed pin (feature 20): consolidation must never supersede,
    -- evict, or compress a pinned fact. Only explicit user action clears it.
    pinned INTEGER NOT NULL DEFAULT 0
    -- NOTE: subject_id is a soft reference to entities(id).
    -- No FK enforced here to allow facts about entity keys that may not yet
    -- have a full entity record (e.g. "self", free-form subjects from LLM extraction).
    -- The application layer is responsible for entity resolution.
  )`,

  `CREATE INDEX IF NOT EXISTS idx_facts_subject_predicate
    ON facts (subject_id, predicate)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts (valid_to)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_invalidated ON facts (invalidated_at)`,

  // ── experience_records (capture journal) ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS experience_records (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    text TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    entities TEXT NOT NULL DEFAULT '[]',
    provenance TEXT NOT NULL DEFAULT '{}',
    raw_ref TEXT NOT NULL DEFAULT '',
    dedup_key TEXT NOT NULL UNIQUE,        -- enforces dedup
    embed_state TEXT NOT NULL DEFAULT 'pending',
    sync_state TEXT NOT NULL DEFAULT 'pending',
    consolidation_pending INTEGER NOT NULL DEFAULT 1
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_dedup
    ON experience_records (dedup_key)`,
  `CREATE INDEX IF NOT EXISTS idx_experience_consolidation
    ON experience_records (consolidation_pending)`,

  // ── embeddings table (for deferred embed queue) ──────────────────────────
  // Vector KNN is accelerated by sqlite-vec when available (see db/vecIndex.ts):
  // a vec0 mirror table is created at runtime over episode/fact embeddings.
  `CREATE TABLE IF NOT EXISTS embeddings (
    node_id TEXT PRIMARY KEY,
    node_kind TEXT NOT NULL,               -- 'episode' | 'entity' | 'fact' | 'experience'
    embedding TEXT NOT NULL,               -- JSON float array
    dim INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // ── procedural_block (singleton) ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS procedural_block (
    id TEXT PRIMARY KEY DEFAULT 'procedural:singleton',
    version INTEGER NOT NULL DEFAULT 1,
    markdown TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    source_fact_ids TEXT NOT NULL DEFAULT '[]'
  )`,

  // ── consolidation_runs ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS consolidation_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    stage INTEGER NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    input_record_ids TEXT NOT NULL DEFAULT '[]',
    counts TEXT NOT NULL DEFAULT '{}',
    errors TEXT NOT NULL DEFAULT '[]',
    trigger TEXT NOT NULL DEFAULT 'manual'
  )`,

  // ── insights ─────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL,
    evidence_fact_ids TEXT NOT NULL DEFAULT '[]',
    window_days INTEGER NOT NULL DEFAULT 1,
    importance INTEGER NOT NULL DEFAULT 5,
    surfaced_in_briefing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
];

/** Idempotent ALTER TABLE migration for columns added after first release. */
function ensureColumn(
  db: import("node:sqlite").DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Run all DDL statements against an open DatabaseSync instance.
 * Idempotent (CREATE IF NOT EXISTS everywhere; column migrations are guarded).
 */
export function applySchema(db: import("node:sqlite").DatabaseSync): void {
  for (const stmt of DDL) {
    db.exec(stmt);
  }
  // feature 20: pin column on databases created before the column existed
  ensureColumn(db, "facts", "pinned", "pinned INTEGER NOT NULL DEFAULT 0");
}
