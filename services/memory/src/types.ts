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
  | "gmail"
  | "gcal"
  | "github"
  | "apple_health"
  | "whoop";

export type ExperienceType =
  | "message"
  | "note"
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
}

// ─── Retrieval (feature 5) ────────────────────────────────────────────────────
export type MemoryKind = "episode" | "entity" | "fact";

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
