/**
 * MemoryStore — the durable, queryable substrate for @jarvis/memory.
 *
 * Backed by SQLite (node:sqlite, built-in Node ≥22).
 *
 * NOTE(future): This implements the temporal knowledge graph patterns from
 * Graphiti (https://github.com/getzep/graphiti). The graph relations
 * (MENTIONS, ABOUT, RELATES_TO, DERIVED_FROM) are encoded as foreign-key
 * columns + junction tables in SQLite. At scale, swap to FalkorDB/Neo4j Cypher.
 *
 * NOTE(scale): Vector search is brute-force cosine over embeddings stored as
 * JSON in SQLite. TODO: swap to sqlite-vec or LanceDB at >50k entries.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  Entity,
  Episode,
  Fact,
  MemoryNode,
  ProceduralBlock,
  Embedder,
  ISO,
  EntityType,
  SourceKind,
} from "../types.js";
import { fromJson, toJson, newId } from "../db/database.js";
import { topKCosine, type VectorEntry } from "../search/cosine.js";
import {
  buildBM25Index,
  type BM25Doc,
  type BM25Index,
} from "../search/bm25.js";

// ── Input types ───────────────────────────────────────────────────────────────

export interface EntityInput {
  id?: string;
  name: string;
  entityType: EntityType;
  aliases?: string[];
  summary?: string;
  text: string;
  provenance: { source: SourceKind; sourceId: string; confidence: number };
  embedding?: number[];
}

export interface EpisodeInput {
  id?: string;
  text: string;
  occurredAt: ISO;
  payload?: Record<string, unknown>;
  entityIds?: string[];
  provenance: { source: SourceKind; sourceId: string; confidence: number };
  embedding?: number[];
}

export interface FactInput {
  id?: string;
  subjectId: string;
  predicate: string;
  objectId?: string;
  objectLiteral?: string;
  text: string;
  validFrom: ISO;
  validTo?: ISO | null;
  supersedes?: string | null;
  sourceTrust?: number;
  /** User-confirmed pin (feature 20). Defaults to false. */
  pinned?: boolean;
  provenance: { source: SourceKind; sourceId: string; confidence: number };
  embedding?: number[];
}

export interface InvalidateFactArgs {
  factId: string;
  validTo: ISO;
  invalidatedBy?: string;
  reason?: string;
}

export interface VectorSearchArgs {
  query: number[];
  k: number;
  tier?: "episodic" | "semantic" | "procedural";
  includeInvalidated?: boolean;
  asOf?: ISO;
}

export interface KeywordSearchArgs {
  query: string;
  k: number;
  includeInvalidated?: boolean;
}

export interface EntitySearchArgs {
  entityIds: string[];
  k: number;
}

export interface SearchResult {
  node: MemoryNode;
  score: number;
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  /** BM25 index over live nodes (default search path). */
  private bm25Index: BM25Index | null = null;
  /** BM25 index including invalidated facts (includeInvalidated searches). */
  private bm25IndexAll: BM25Index | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Escape hatch for sibling services (profile, forget) that run bespoke SQL
   * against the store's database. Internal to @jarvis/memory — not part of
   * the package's public surface.
   */
  get rawDb(): DatabaseSync {
    return this.db;
  }

  // ── Entity operations ──────────────────────────────────────────────────────

  /**
   * Upsert an entity applying the deterministic 5-step entity-resolution merge
   * rule (spec feature 4, "Entity-resolution / merge rule").
   */
  async upsertEntity(input: EntityInput): Promise<Entity> {
    const now = new Date().toISOString();
    const prov = {
      source: input.provenance.source,
      sourceId: input.provenance.sourceId,
      capturedBy: "feature-3" as const,
      confidence: input.provenance.confidence,
    };

    // Step 1: exact id match
    if (input.id) {
      const existing = this.getEntityById(input.id);
      if (existing) {
        this.mergeEntityAliases(existing.id, input.name);
        return this.getEntityById(existing.id)!;
      }
    }

    // Step 2: exact normalized-name + same entityType
    const normName = normalizeName(input.name);
    const byName = this.db.prepare(
      `SELECT * FROM entities WHERE name = ? AND entity_type = ? LIMIT 1`,
    ).get(normName, input.entityType) as RawEntity | null | undefined;
    if (byName) {
      this.mergeEntityAliases(byName.id, input.name);
      return this.rowToEntity(byName);
    }

    // Step 3: alias hit
    const allEntities = this.db
      .prepare(`SELECT * FROM entities WHERE entity_type = ?`)
      .all(input.entityType) as unknown as RawEntity[];
    for (const e of allEntities) {
      const aliases = fromJson<string[]>(e.aliases, []);
      if (aliases.some((a) => normalizeName(a) === normName)) {
        return this.rowToEntity(e);
      }
    }

    // Step 4: high-similarity vector match (cosine ≥ 0.92, same entityType)
    // Only attempted if we have an embedding.
    if (input.embedding) {
      const candidates = allEntities
        .filter((e) => e.embedding != null)
        .map((e) => ({
          id: e.id,
          embedding: fromJson<number[]>(e.embedding as string, []),
        }));
      if (candidates.length > 0) {
        const top = topKCosine(input.embedding, candidates, 1);
        if (top.length > 0 && (top[0]?.score ?? 0) >= 0.92) {
          const matched = allEntities.find((e) => e.id === top[0]?.id);
          if (matched) {
            this.mergeEntityAliases(matched.id, input.name);
            return this.rowToEntity(matched);
          }
        }
      }
    }

    // Step 5: create new canonical entity
    const id = input.id ?? newId();
    const aliases = input.aliases ?? [];
    if (!aliases.includes(input.name)) aliases.push(input.name);

    this.db.prepare(`
      INSERT INTO entities
        (id, name, entity_type, aliases, merged_from, summary, text, embedding,
         ingested_at, importance, last_accessed_at, access_count, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normName,
      input.entityType,
      toJson(aliases),
      toJson([]),
      input.summary ?? null,
      input.text,
      input.embedding ? toJson(input.embedding) : null,
      now,
      5,
      Date.now(),
      0,
      toJson(prov),
    );

    return this.getEntityById(id)!;
  }

  getEntityById(id: string): Entity | null {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE id = ?`)
      .get(id) as RawEntity | null | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  private mergeEntityAliases(entityId: string, newAlias: string): void {
    const row = this.db
      .prepare(`SELECT aliases FROM entities WHERE id = ?`)
      .get(entityId) as { aliases: string } | null | undefined;
    if (!row) return;
    const aliases = fromJson<string[]>(row.aliases, []);
    if (!aliases.includes(newAlias)) {
      aliases.push(newAlias);
      this.db
        .prepare(`UPDATE entities SET aliases = ? WHERE id = ?`)
        .run(toJson(aliases), entityId);
    }
  }

  /** Merge two entities: absorb `sourceId` into `targetId`. */
  mergeEntity(targetId: string, sourceId: string): void {
    const source = this.getEntityById(sourceId);
    if (!source) return;
    // Append aliases and mergedFrom
    const tRow = this.db
      .prepare(`SELECT aliases, merged_from FROM entities WHERE id = ?`)
      .get(targetId) as { aliases: string; merged_from: string } | null | undefined;
    if (!tRow) return;
    const aliases = fromJson<string[]>(tRow.aliases, []);
    const mergedFrom = fromJson<string[]>(tRow.merged_from, []);
    for (const a of source.aliases) {
      if (!aliases.includes(a)) aliases.push(a);
    }
    if (!mergedFrom.includes(sourceId)) mergedFrom.push(sourceId);
    this.db
      .prepare(`UPDATE entities SET aliases = ?, merged_from = ? WHERE id = ?`)
      .run(toJson(aliases), toJson(mergedFrom), targetId);
    // Repoint facts
    this.db
      .prepare(`UPDATE facts SET subject_id = ? WHERE subject_id = ?`)
      .run(targetId, sourceId);
  }

  // ── Episode operations ────────────────────────────────────────────────────

  async upsertEpisode(input: EpisodeInput): Promise<Episode> {
    const now = new Date().toISOString();
    const id = input.id ?? newId();
    const prov = {
      source: input.provenance.source,
      sourceId: input.provenance.sourceId,
      capturedBy: "feature-3" as const,
      confidence: input.provenance.confidence,
    };

    // Embed if needed
    let embedding = input.embedding;
    if (!embedding) {
      const [vec] = await this.embedder.embed([input.text]);
      embedding = vec;
    }

    const existing = this.db
      .prepare(`SELECT id FROM episodes WHERE id = ?`)
      .get(id) as { id: string } | null | undefined;

    if (existing) {
      // Idempotent upsert: update embedding if present
      if (embedding) {
        this.db
          .prepare(`UPDATE episodes SET embedding = ? WHERE id = ?`)
          .run(toJson(embedding), id);
      }
    } else {
      this.db.prepare(`
        INSERT INTO episodes
          (id, text, embedding, occurred_at, ingested_at, payload, entity_ids,
           derived_fact_ids, importance, last_accessed_at, access_count, provenance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.text,
        embedding ? toJson(embedding) : null,
        input.occurredAt,
        now,
        toJson(input.payload ?? {}),
        toJson(input.entityIds ?? []),
        toJson([]),
        5,
        Date.now(),
        0,
        toJson(prov),
      );
    }

    // Update BM25 index
    this.invalidateBm25();

    return this.getEpisodeById(id)!;
  }

  getEpisodeById(id: string): Episode | null {
    const row = this.db
      .prepare(`SELECT * FROM episodes WHERE id = ?`)
      .get(id) as RawEpisode | null | undefined;
    return row ? this.rowToEpisode(row) : null;
  }

  // ── Fact operations ────────────────────────────────────────────────────────

  async upsertFact(input: FactInput): Promise<Fact> {
    const now = new Date().toISOString();
    const id = input.id ?? newId();
    const prov = {
      source: input.provenance.source,
      sourceId: input.provenance.sourceId,
      capturedBy: "feature-3" as const,
      confidence: input.provenance.confidence,
    };

    let embedding = input.embedding;
    if (!embedding) {
      const [vec] = await this.embedder.embed([input.text]);
      embedding = vec;
    }

    // Plain INSERT: facts are bi-temporal and never overwritten in place.
    // A duplicate id throws — corrections must go through invalidate + insert.
    this.db.prepare(`
      INSERT INTO facts
        (id, subject_id, predicate, object_id, object_literal, text, embedding,
         valid_from, valid_to, ingested_at, invalidated_at, invalidated_by,
         supersedes, importance, last_accessed_at, access_count, provenance, source_trust,
         pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.subjectId,
      input.predicate,
      input.objectId ?? null,
      input.objectLiteral ?? null,
      input.text,
      embedding ? toJson(embedding) : null,
      input.validFrom,
      input.validTo ?? null,
      now,
      null,
      null,
      input.supersedes ?? null,
      5,
      Date.now(),
      0,
      toJson(prov),
      input.sourceTrust ?? 0.5,
      input.pinned ? 1 : 0,
    );

    this.invalidateBm25();
    return this.getFactById(id)!;
  }

  /** Close out a fact's validity window (bi-temporal invalidation). */
  invalidateFact(args: InvalidateFactArgs): Fact | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(`SELECT * FROM facts WHERE id = ?`)
      .get(args.factId) as RawFact | null | undefined;
    if (!row) return null;

    // Idempotent — if already invalidated, no-op and warn.
    if (row.invalidated_at !== null) {
      console.warn(`[memory] invalidateFact: fact ${args.factId} already invalidated`);
      return this.rowToFact(row);
    }

    this.db.prepare(`
      UPDATE facts
      SET valid_to = ?, invalidated_at = ?, invalidated_by = ?
      WHERE id = ?
    `).run(args.validTo, now, args.invalidatedBy ?? null, args.factId);

    // The cached BM25 index would otherwise keep serving the invalidated fact.
    this.invalidateBm25();

    return this.getFactById(args.factId);
  }

  /** Set/clear the user pin on a fact (feature 20). Returns null if not found. */
  setFactPinned(factId: string, pinned: boolean): Fact | null {
    const res = this.db
      .prepare(`UPDATE facts SET pinned = ? WHERE id = ?`)
      .run(pinned ? 1 : 0, factId);
    if (Number(res.changes) === 0) return null;
    return this.getFactById(factId);
  }

  getFactById(id: string): Fact | null {
    const row = this.db
      .prepare(`SELECT * FROM facts WHERE id = ?`)
      .get(id) as RawFact | null | undefined;
    return row ? this.rowToFact(row) : null;
  }

  /**
   * Get all versions of a fact (all validFrom/validTo intervals) for a subject+predicate.
   * Ordered oldest-first.
   */
  getFactHistory(subjectId: string, predicate?: string): Fact[] {
    const rows = predicate
      ? (this.db
          .prepare(
            `SELECT * FROM facts WHERE subject_id = ? AND predicate = ? ORDER BY valid_from ASC`,
          )
          .all(subjectId, predicate) as unknown as RawFact[])
      : (this.db
          .prepare(`SELECT * FROM facts WHERE subject_id = ? ORDER BY valid_from ASC`)
          .all(subjectId) as unknown as RawFact[]);
    return rows.map((r) => this.rowToFact(r));
  }

  /**
   * Returns facts valid (event-time) at a given asOf time.
   * "What was actually true in the world on date asOf?"
   */
  factsValidAt(subjectId: string, asOf: ISO, predicate?: string): Fact[] {
    const base = this.getFactHistory(subjectId, predicate);
    return base.filter(
      (f) =>
        f.validFrom <= asOf &&
        (f.validTo === null || f.validTo > asOf),
    );
  }

  // ── Procedural block ──────────────────────────────────────────────────────

  getProceduralBlock(): ProceduralBlock | null {
    const row = this.db
      .prepare(`SELECT * FROM procedural_block WHERE id = 'procedural:singleton'`)
      .get() as RawProcedural | null | undefined;
    return row ? this.rowToProcedural(row) : null;
  }

  writeProceduralBlock(
    markdown: string,
    sourceFactIds: string[],
    by: "feature-6" | "feature-20",
  ): ProceduralBlock {
    const now = new Date().toISOString();
    const existing = this.getProceduralBlock();
    const version = existing ? existing.version + 1 : 1;

    this.db.prepare(`
      INSERT OR REPLACE INTO procedural_block
        (id, version, markdown, updated_at, updated_by, source_fact_ids)
      VALUES ('procedural:singleton', ?, ?, ?, ?, ?)
    `).run(version, markdown, now, by, toJson(sourceFactIds));

    return this.getProceduralBlock()!;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /** Brute-force cosine vector search over all memory nodes. */
  vectorSearch(args: VectorSearchArgs): SearchResult[] {
    const { query, k, includeInvalidated = false, asOf } = args;
    const now = new Date().toISOString();

    const entries: VectorEntry[] = [];

    // Episodes
    const episodes = this.db
      .prepare(`SELECT id, embedding FROM episodes WHERE embedding IS NOT NULL`)
      .all() as unknown as { id: string; embedding: string }[];
    for (const e of episodes) {
      entries.push({ id: `ep:${e.id}`, embedding: fromJson<number[]>(e.embedding, []) });
    }

    // Facts
    const factQuery = `SELECT id, embedding, valid_from, valid_to, invalidated_at FROM facts WHERE embedding IS NOT NULL`;
    const factRows = this.db.prepare(factQuery).all() as unknown as {
      id: string;
      embedding: string;
      valid_from: string;
      valid_to: string | null;
      invalidated_at: string | null;
    }[];
    for (const f of factRows) {
      if (!includeInvalidated) {
        if (f.invalidated_at !== null) continue;
        if (asOf && f.valid_from > asOf) continue; // not yet true at asOf
        if (asOf && f.valid_to !== null && f.valid_to <= asOf) continue;
        if (!asOf && f.valid_to !== null && f.valid_to <= now) continue;
      }
      entries.push({ id: `fact:${f.id}`, embedding: fromJson<number[]>(f.embedding, []) });
    }

    if (entries.length === 0) return [];

    const topK = topKCosine(query, entries, k);
    const results: SearchResult[] = [];

    for (const scored of topK) {
      const [kind, id] = scored.id.split(":");
      let node: MemoryNode | null = null;
      if (kind === "ep") {
        node = this.getEpisodeById(id ?? "");
      } else if (kind === "fact") {
        node = this.getFactById(id ?? "");
      }
      if (node) results.push({ node, score: scored.score });
    }

    return results;
  }

  /** BM25 keyword search over all memory text (live facts only by default). */
  keywordSearch(args: KeywordSearchArgs): SearchResult[] {
    const index = this.getBm25Index(args.includeInvalidated ?? false);
    const results = index.search(args.query, args.k);
    const out: SearchResult[] = [];
    for (const r of results) {
      const [kind, id] = r.id.split(":");
      let node: MemoryNode | null = null;
      if (kind === "ep") {
        node = this.getEpisodeById(id ?? "");
      } else if (kind === "fact") {
        node = this.getFactById(id ?? "");
      }
      if (node) out.push({ node, score: r.score });
    }
    return out;
  }

  /** Entity-linked memory search. */
  entitySearch(args: EntitySearchArgs): SearchResult[] {
    const results: SearchResult[] = [];
    if (args.entityIds.length === 0) return results;
    const likeClauses = args.entityIds.map(() => "entity_ids LIKE ?").join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes WHERE ${likeClauses} LIMIT ?`,
      )
      .all(
        ...args.entityIds.map((id) => `%${id}%`),
        args.k,
      ) as unknown as RawEpisode[];
    for (const r of rows) {
      const ep = this.rowToEpisode(r);
      const entityIds = ep.entityIds;
      if (args.entityIds.some((id) => entityIds.includes(id))) {
        results.push({ node: ep, score: 1.0 });
      }
    }
    // Also search facts
    for (const entityId of args.entityIds) {
      const factRows = this.db
        .prepare(
          `SELECT * FROM facts WHERE subject_id = ? AND invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > ?) LIMIT ?`,
        )
        .all(entityId, new Date().toISOString(), args.k) as unknown as RawFact[];
      for (const r of factRows) {
        results.push({ node: this.rowToFact(r), score: 1.0 });
      }
    }
    return results.slice(0, args.k);
  }

  // ── Access tracking ───────────────────────────────────────────────────────

  touchAccess(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) {
      // Try episodes and facts
      this.db
        .prepare(
          `UPDATE episodes SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`,
        )
        .run(now, id);
      this.db
        .prepare(
          `UPDATE facts SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`,
        )
        .run(now, id);
    }
  }

  // ── Experience records (capture journal) ─────────────────────────────────

  insertExperienceIfNew(record: import("../types.js").ExperienceRecord): boolean {
    try {
      this.db.prepare(`
        INSERT INTO experience_records
          (id, source, type, timestamp, ingested_at, actor, text, payload,
           entities, provenance, raw_ref, dedup_key, embed_state, sync_state, consolidation_pending)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.source,
        record.type,
        record.timestamp,
        record.ingested_at,
        record.actor,
        record.text,
        toJson(record.payload),
        toJson(record.entities),
        toJson(record.provenance),
        record.raw_ref,
        record.dedup_key,
        record.embed_state,
        record.sync_state,
        record.consolidation_pending ? 1 : 0,
      );
      return true;
    } catch {
      // UNIQUE constraint on dedup_key → duplicate
      return false;
    }
  }

  getPendingExperienceRecords(): import("../types.js").ExperienceRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM experience_records WHERE consolidation_pending = 1`)
      .all() as unknown as RawExperience[];
    return rows.map(this.rowToExperience);
  }

  markExperienceConsolidated(id: string): void {
    this.db
      .prepare(`UPDATE experience_records SET consolidation_pending = 0 WHERE id = ?`)
      .run(id);
  }

  updateExperienceEmbedState(
    id: string,
    state: "pending" | "deferred" | "done",
  ): void {
    this.db
      .prepare(`UPDATE experience_records SET embed_state = ? WHERE id = ?`)
      .run(state, id);
  }

  // ── Embeddings table (deferred embed queue) ───────────────────────────────

  /** Persist a node's embedding vector into the embeddings table. */
  upsertEmbedding(
    nodeId: string,
    nodeKind: "episode" | "entity" | "fact" | "experience",
    embedding: number[],
  ): void {
    this.db.prepare(`
      INSERT INTO embeddings (node_id, node_kind, embedding, dim, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        node_kind = excluded.node_kind,
        embedding = excluded.embedding,
        dim = excluded.dim,
        updated_at = excluded.updated_at
    `).run(nodeId, nodeKind, toJson(embedding), embedding.length, new Date().toISOString());
  }

  // ── Consolidation runs ────────────────────────────────────────────────────

  insertConsolidationRun(run: import("../types.js").ConsolidationRun): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO consolidation_runs
        (id, started_at, finished_at, status, stage, window_start, window_end,
         input_record_ids, counts, errors, trigger)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.startedAt,
      run.finishedAt ?? null,
      run.status,
      run.stage,
      run.windowStart,
      run.windowEnd,
      toJson(run.inputRecordIds),
      toJson(run.counts),
      toJson(run.errors),
      run.trigger,
    );
  }

  updateConsolidationRun(
    id: string,
    fields: Partial<import("../types.js").ConsolidationRun>,
  ): void {
    const existing = this.db
      .prepare(`SELECT * FROM consolidation_runs WHERE id = ?`)
      .get(id) as RawConsolidationRun | null | undefined;
    if (!existing) return;
    const merged = {
      finishedAt: fields.finishedAt ?? existing.finished_at ?? null,
      status: fields.status ?? existing.status,
      stage: fields.stage ?? existing.stage,
      counts: fields.counts ? toJson(fields.counts) : existing.counts,
      errors: fields.errors ? toJson(fields.errors) : existing.errors,
    };
    this.db.prepare(`
      UPDATE consolidation_runs
      SET finished_at = ?, status = ?, stage = ?, counts = ?, errors = ?
      WHERE id = ?
    `).run(merged.finishedAt, merged.status, merged.stage, merged.counts, merged.errors, id);
  }

  insertInsight(insight: import("../types.js").Insight): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO insights
        (id, run_id, text, kind, evidence_fact_ids, window_days,
         importance, surfaced_in_briefing, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      insight.id,
      insight.runId,
      insight.text,
      insight.kind,
      toJson(insight.evidenceFactIds),
      insight.windowDays,
      insight.importance,
      insight.surfacedInBriefing ? 1 : 0,
      insight.createdAt,
    );
  }

  // ── BM25 index (lazy, invalidated on writes) ──────────────────────────────

  private invalidateBm25(): void {
    this.bm25Index = null;
    this.bm25IndexAll = null;
  }

  private getBm25Index(includeInvalidated: boolean): BM25Index {
    const cached = includeInvalidated ? this.bm25IndexAll : this.bm25Index;
    if (cached) return cached;

    const docs: BM25Doc[] = [];
    const episodes = this.db
      .prepare(`SELECT id, text FROM episodes`)
      .all() as unknown as { id: string; text: string }[];
    for (const e of episodes) {
      docs.push({ id: `ep:${e.id}`, text: e.text });
    }
    // Default index covers only live facts — invalidated/superseded facts must
    // not keep surfacing via keyword retrieval.
    const facts = (
      includeInvalidated
        ? this.db.prepare(`SELECT id, text FROM facts`).all()
        : this.db
            .prepare(
              `SELECT id, text FROM facts
               WHERE invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > ?)`,
            )
            .all(new Date().toISOString())
    ) as unknown as { id: string; text: string }[];
    for (const f of facts) {
      docs.push({ id: `fact:${f.id}`, text: f.text });
    }

    const index = buildBM25Index(docs);
    if (includeInvalidated) {
      this.bm25IndexAll = index;
    } else {
      this.bm25Index = index;
    }
    return index;
  }

  // ── Row mappers ───────────────────────────────────────────────────────────

  private rowToEntity(row: RawEntity): Entity {
    return {
      id: row.id,
      tier: "semantic",
      kind: "entity",
      name: row.name,
      entityType: row.entity_type as EntityType,
      aliases: fromJson<string[]>(row.aliases, []),
      mergedFrom: fromJson<string[]>(row.merged_from, []),
      summary: row.summary ?? undefined,
      text: row.text,
      embedding: row.embedding ? fromJson<number[]>(row.embedding as string, []) : undefined,
      ingestedAt: row.ingested_at,
      importance: row.importance,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      provenance: fromJson(row.provenance, {
        source: "system" as SourceKind,
        sourceId: "",
        capturedBy: "feature-3" as const,
        confidence: 1,
      }),
    };
  }

  private rowToEpisode(row: RawEpisode): Episode {
    return {
      id: row.id,
      tier: "episodic",
      kind: "episode",
      text: row.text,
      embedding: row.embedding ? fromJson<number[]>(row.embedding as string, []) : undefined,
      occurredAt: row.occurred_at,
      ingestedAt: row.ingested_at,
      payload: fromJson<Record<string, unknown>>(row.payload, {}),
      entityIds: fromJson<string[]>(row.entity_ids, []),
      derivedFactIds: fromJson<string[]>(row.derived_fact_ids, []),
      importance: row.importance,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      provenance: fromJson(row.provenance, {
        source: "system" as SourceKind,
        sourceId: "",
        capturedBy: "feature-3" as const,
        confidence: 1,
      }),
    };
  }

  private rowToFact(row: RawFact): Fact {
    return {
      id: row.id,
      tier: "semantic",
      kind: "fact",
      subjectId: row.subject_id,
      predicate: row.predicate,
      objectId: row.object_id ?? undefined,
      objectLiteral: row.object_literal ?? undefined,
      text: row.text,
      embedding: row.embedding ? fromJson<number[]>(row.embedding as string, []) : undefined,
      validFrom: row.valid_from,
      validTo: row.valid_to ?? null,
      ingestedAt: row.ingested_at,
      invalidatedAt: row.invalidated_at ?? null,
      invalidatedBy: row.invalidated_by ?? null,
      supersedes: row.supersedes ?? null,
      sourceTrust: row.source_trust,
      pinned: row.pinned === 1,
      importance: row.importance,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      provenance: fromJson(row.provenance, {
        source: "system" as SourceKind,
        sourceId: "",
        capturedBy: "feature-3" as const,
        confidence: 1,
      }),
    };
  }

  private rowToProcedural(row: RawProcedural): ProceduralBlock {
    return {
      id: "procedural:singleton",
      version: row.version,
      markdown: row.markdown,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by as "feature-6" | "feature-20",
      sourceFactIds: fromJson<string[]>(row.source_fact_ids, []),
    };
  }

  private rowToExperience(
    row: RawExperience,
  ): import("../types.js").ExperienceRecord {
    return {
      id: row.id,
      source: row.source as import("../types.js").SourceId,
      type: row.type as import("../types.js").ExperienceType,
      timestamp: row.timestamp,
      ingested_at: row.ingested_at,
      actor: row.actor,
      text: row.text,
      payload: fromJson<Record<string, unknown>>(row.payload, {}),
      entities: fromJson<import("../types.js").CaptureEntity[]>(row.entities, []),
      provenance: fromJson<import("../types.js").CaptureProvenance>(row.provenance, {
        adapter: "conversation",
        adapter_version: "1.0.0",
        via: "in_process",
        source_id: "",
        cursor_at: "",
      }),
      raw_ref: row.raw_ref,
      dedup_key: row.dedup_key,
      embed_state: row.embed_state as "pending" | "deferred" | "done",
      sync_state: row.sync_state as "pending" | "synced" | "error",
      consolidation_pending: row.consolidation_pending === 1,
    };
  }
}

// ── Raw DB row types ──────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.trim().toLowerCase().normalize("NFC");
}

interface RawEntity {
  id: string;
  name: string;
  entity_type: string;
  aliases: string;
  merged_from: string;
  summary: string | null;
  text: string;
  embedding: string | null;
  ingested_at: string;
  importance: number;
  last_accessed_at: number;
  access_count: number;
  provenance: string;
}

interface RawEpisode {
  id: string;
  text: string;
  embedding: string | null;
  occurred_at: string;
  ingested_at: string;
  payload: string;
  entity_ids: string;
  derived_fact_ids: string;
  importance: number;
  last_accessed_at: number;
  access_count: number;
  provenance: string;
  consolidation_pending: number;
}

interface RawFact {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  object_literal: string | null;
  text: string;
  embedding: string | null;
  valid_from: string;
  valid_to: string | null;
  ingested_at: string;
  invalidated_at: string | null;
  invalidated_by: string | null;
  supersedes: string | null;
  importance: number;
  last_accessed_at: number;
  access_count: number;
  provenance: string;
  source_trust: number;
  pinned: number;
}

interface RawProcedural {
  id: string;
  version: number;
  markdown: string;
  updated_at: string;
  updated_by: string;
  source_fact_ids: string;
}

interface RawExperience {
  id: string;
  source: string;
  type: string;
  timestamp: string;
  ingested_at: string;
  actor: string;
  text: string;
  payload: string;
  entities: string;
  provenance: string;
  raw_ref: string;
  dedup_key: string;
  embed_state: string;
  sync_state: string;
  consolidation_pending: number;
}

interface RawConsolidationRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  stage: number;
  window_start: string;
  window_end: string;
  input_record_ids: string;
  counts: string;
  errors: string;
  trigger: string;
}
