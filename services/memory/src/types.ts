/**
 * Shared types for @jarvis/memory — features 3, 4, 5, 6.
 *
 * All timestamps are UTC ISO-8601 strings ("ISO" type alias).
 * IDs are ULIDs (sortable, time-prefixed).
 */

export type ISO = string;
export type MemoryTier = "episodic" | "semantic" | "procedural";
export type EntityType =
  | "person"
  | "project"
  | "org"
  | "place"
  | "topic"
  | "tool"
  | "event"
  | "other";
export type SourceKind =
  | "chat"
  | "note"
  | "file"
  | "browser"
  | "calendar"
  | "email"
  | "system"
  | "consolidation";

// ─── Provenance ──────────────────────────────────────────────────────────────
export interface Provenance {
  source: SourceKind;
  sourceId: string;
  capturedBy: "feature-3" | "feature-6" | "feature-20";
  confidence: number; // 0..1
}

// ─── Core node ───────────────────────────────────────────────────────────────
export interface MemoryNode {
  id: string;
  tier: MemoryTier;
  kind: "episode" | "entity" | "fact";
  text: string;
  embedding?: number[];
  ingestedAt: ISO;
  provenance: Provenance;
  /** Salience 1-10, set by consolidation (feature 6). Defaults to 5. */
  importance: number;
  /** Unix epoch ms of last retrieval access (for recency decay). */
  lastAccessedAt: number;
  /** Total retrieval access count. */
  accessCount: number;
}

// ─── Episode ─────────────────────────────────────────────────────────────────
export interface Episode extends MemoryNode {
  kind: "episode";
  tier: "episodic";
  occurredAt: ISO;
  payload?: Record<string, unknown>;
  entityIds: string[];
  derivedFactIds: string[];
}

// ─── Entity ──────────────────────────────────────────────────────────────────
export interface Entity extends MemoryNode {
  kind: "entity";
  tier: "semantic";
  name: string;
  entityType: EntityType;
  aliases: string[];
  mergedFrom: string[];
  summary?: string;
}

// ─── Fact (bi-temporal, versioned) ───────────────────────────────────────────
export interface Fact extends MemoryNode {
  kind: "fact";
  tier: "semantic";
  subjectId: string;
  predicate: string;
  objectId?: string;
  objectLiteral?: string;
  // ── BI-TEMPORAL MODEL ──────────────────────────────────────────────────────
  // Event time: when the fact was true in the world.
  validFrom: ISO;
  validTo: ISO | null; // null = currently true
  // System time: when Jarvis learned / unlearned it.
  // ingestedAt inherited from MemoryNode.
  invalidatedAt: ISO | null; // null = live
  invalidatedBy: string | null; // factId that supersedes
  supersedes: string | null; // factId this one replaced
  /** Trust of the originating source (0..1). User corrections are 1.0. */
  sourceTrust: number;
  /** User-confirmed (feature 20): never auto-overwritten by consolidation. */
  pinned: boolean;
}

// ─── Procedural block (singleton) ────────────────────────────────────────────
export interface ProceduralBlock {
  id: "procedural:singleton";
  version: number;
  markdown: string;
  updatedAt: ISO;
  updatedBy: "feature-6" | "feature-20";
  sourceFactIds: string[];
}

// ─── Capture (feature 3) ─────────────────────────────────────────────────────
export type SourceId =
  | "conversation"
  | "note"
  | "obsidian"
  | "files"
  | "gmail"
  | "gcal"
  | "github"
  | "apple_health"
  | "whoop";

export type ExperienceType =
  | "message"
  | "note"
  | "document"
  | "email"
  | "calendar_event"
  | "code_activity"
  | "health_metric"
  | "sleep"
  | "recovery"
  | "workout";

export interface CaptureEntity {
  kind: "person" | "repo" | "email" | "org" | "place" | "tag";
  value: string;
}

export interface CaptureProvenance {
  adapter: SourceId;
  adapter_version: string;
  via: "pull" | "webhook" | "in_process";
  source_id: string;
  cursor_at: string;
}

export interface ExperienceRecord {
  id: string;
  source: SourceId;
  type: ExperienceType;
  timestamp: string;
  ingested_at: string;
  actor: string;
  text: string;
  payload: Record<string, unknown>;
  entities: CaptureEntity[];
  provenance: CaptureProvenance;
  raw_ref: string;
  dedup_key: string;
  embed_state: "pending" | "deferred" | "done";
  sync_state: "pending" | "synced" | "error";
  consolidation_pending: boolean;
  /** MEM-02: number of failed consolidation-extraction attempts for this record. */
  consolidationAttempts: number;
  /** MEM-02: message from the most recent failed extraction attempt, if any. */
  lastConsolidationError: string | null;
  /** MEM-02: unix ms after which this record is eligible for retry. null = eligible now. */
  nextRetryAt: number | null;
  /** MEM-02: true once the record has exhausted its retry budget (never hard-deleted). */
  deadLetter: boolean;
}

// ─── Retrieval (feature 5) ────────────────────────────────────────────────────
/** MEM-01: "pending" identifies a not-yet-consolidated (or dead-lettered)
 *  experience_record surfaced via the pendingRetriever — always provisional. */
export type MemoryKind = "episode" | "entity" | "fact" | "pending";

export interface RetrievedMemory {
  memoryId: string;
  text: string;
  kind: MemoryKind;
  fusedScore: number;
  scoreBreakdown: {
    recency: number;
    importance: number;
    relevance: number;
    signals: { vector: number; bm25: number; entity: number };
    rerankerScore?: number;
  };
  placementHint: "edge_top" | "edge_bottom" | "middle";
  validFrom: number;
  rank: number;
}

export interface RetrievalOptions {
  k?: number;
  now?: number;
  includeStale?: boolean;
  minRelevance?: number;
  entityIds?: string[];
  /** MEM-01: include not-yet-consolidated/dead-lettered experience_records via
   *  the pendingRetriever. Defaults to true at the RetrievalService call site. */
  includePending?: boolean;
}

// ─── Consolidation (feature 6) ────────────────────────────────────────────────
export interface ExtractedFact {
  id: string;
  runId: string;
  sourceRecordId: string;
  entity: string;
  predicate: string;
  object: string;
  text: string;
  confidence: number;
  importance?: number;
  validFrom: string;
  validTo: string | null;
  sourceTrust: number;
  embedding?: number[];
  supersedesFactId?: string;
}

export interface Insight {
  id: string;
  runId: string;
  text: string;
  kind: "pattern" | "trend" | "preference" | "anomaly";
  evidenceFactIds: string[];
  windowDays: number;
  importance: number;
  surfacedInBriefing: boolean;
  createdAt: string;
}

export interface ForgetDecision {
  factId: string;
  action: "keep" | "evict" | "compress";
  decayScore: number;
  lastAccessedAt?: string;
  accessCount: number;
  importance: number;
  protectedByFloor: boolean;
  reason: string;
}

export interface ConsolidationRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed" | "partial";
  stage: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  windowStart: string;
  windowEnd: string;
  inputRecordIds: string[];
  counts: {
    recordsProcessed: number;
    factsExtracted: number;
    factsMerged: number;
    factsInvalidated: number;
    factsForgotten: number;
    factsCompressed: number;
    insightsGenerated: number;
    embeddingsWritten: number;
    /** Feature 20: incoming facts kept live alongside a conflicting/pinned prior. */
    conflictsFlagged: number;
  };
  errors: { stage: number; message: string; recordId?: string }[];
  trigger: "scheduler" | "manual";
}

/** MEM-03: pending/consolidated/dead-letter corpus counts plus the most
 *  recent consolidation_runs row — the read-only observability surface
 *  consumed by core's GET /telemetry and the dashboard's /api/memory/health. */
export interface ConsolidationHealth {
  pendingCount: number;
  consolidatedCount: number;
  deadLetterCount: number;
  lastRun: ConsolidationRun | null;
}

// ─── Injected interfaces (DI) ─────────────────────────────────────────────────
/**
 * Embedding function interface — injected so @jarvis/memory does NOT depend on
 * @jarvis/core or any native addon.
 */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * LLM completion interface — injected for consolidation's AI stages.
 * Only used in non-hot-path (consolidation) — never in retrieval scoring.
 */
export interface LlmClient {
  complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
  }): Promise<string>;
}

/**
 * Reranker interface — an optional second-stage relevance model (cross-encoder).
 *
 * First-stage retrieval (vector + BM25 + entity) produces a candidate set; the
 * reranker re-scores the top candidates jointly against the query for sharper
 * relevance than the lexical/vector blend can give. Injected (DI) so @jarvis/memory
 * stays free of @jarvis/core and any model server — core wires the real one,
 * tests use FakeReranker.
 *
 * Contract:
 *  - Returns one score per input document, in the SAME order as `documents`.
 *  - Higher = more relevant. Scores may be any real number (logits); the caller
 *    normalizes. Returning fewer/more scores than docs, or throwing, is treated
 *    as "reranker unavailable" and retrieval falls back to first-stage order.
 */
export interface Reranker {
  rerank(query: string, documents: string[]): Promise<number[]>;
}

/**
 * Clock interface — injected so consolidation retry/backoff bookkeeping (MEM-02)
 * is deterministically testable without sleeping or fake timers.
 *
 * Mirrored (not imported) from @jarvis/integrations' identical Clock interface —
 * leaf packages are siblings and must not depend on each other.
 */
export interface Clock {
  now(): number; // Unix timestamp ms
}
