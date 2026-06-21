/**
 * @jarvis/memory — public API.
 *
 * createMemorySystem({ embedder, llm, dataDir }) returns:
 *   {
 *     capture:       { captureConversationTurn, captureNote, captureExternal }
 *     store:         MemoryStore instance (for advanced use)
 *     retrieval:     { retrieve, getProceduralBlock }
 *     consolidation: { run }
 *   }
 *
 * The embedder and llm are injected so this package does NOT depend on @jarvis/core
 * or any native addon. Use FakeEmbedder / FakeLlm from @jarvis/memory/testing for
 * tests or local development without a real model server.
 */

import { openDatabase } from "./db/database.js";
import { MemoryStore } from "./store/memoryStore.js";
import { CaptureService } from "./capture/capture.js";
import type { buildExternalRecord } from "./capture/experience.js";
import { RetrievalService } from "./retrieval/retrieval.js";
import { ConsolidationService } from "./consolidation/consolidation.js";
import { ProfileService } from "./profile/profile.js";
import type { Embedder, LlmClient, Reranker, RetrievalOptions, RetrievedMemory } from "./types.js";
import type { ConsolidationResult } from "./consolidation/consolidation.js";

export type { Embedder, LlmClient, Reranker };
export type {
  ExperienceRecord,
  Entity,
  Fact,
  Episode,
  MemoryNode,
  MemoryTier,
  ProceduralBlock,
  RetrievedMemory,
  RetrievalOptions,
  ConsolidationRun,
  ExtractedFact,
  Insight,
  ForgetDecision,
} from "./types.js";
export type {
  PersonalProfile,
  ProfileFact,
  Person,
  Project,
  Routine,
  CorrectFactArgs,
  EditFacetArgs,
  ForgetEntityArgs,
} from "./profile/types.js";
export { ProfileService } from "./profile/profile.js";
export { buildProfileContext } from "./profile/inject.js";
export type { ProfileContextOptions } from "./profile/inject.js";
export { MemoryStore } from "./store/memoryStore.js";
export { BM25Index, buildBM25Index } from "./search/bm25.js";
export { cosineSimilarity, topKCosine } from "./search/cosine.js";
export {
  scoreMemory,
  recencyScore,
  relevanceScore,
  normalizeBm25,
  normalizeCosine,
  DEFAULT_SCORING_CONFIG,
} from "./retrieval/scoring.js";
export { isLiveFact, wasTrueAt, wasBelivedAt, factsBelivedAt, factsTrueAt, liveFacts } from "./store/bitemporal.js";
export { computeDedupKey, buildConversationRecord, buildNoteRecord, buildExternalRecord } from "./capture/experience.js";
export { parseMarkdownNote, buildMarkdownRecord } from "./capture/adapters/markdown.js";
export type { ParsedMarkdown } from "./capture/adapters/markdown.js";
export { chunkText } from "./capture/chunk.js";
export type { ChunkOptions, TextChunk } from "./capture/chunk.js";
export { buildDocumentChunkRecords } from "./capture/adapters/document.js";

// ── Memory system factory ──────────────────────────────────────────────────────

export interface MemorySystemConfig {
  embedder: Embedder;
  llm: LlmClient;
  dataDir: string;
  /** Optional second-stage reranker for sharper retrieval. Omit to disable. */
  reranker?: Reranker;
}

export interface MemorySystem {
  capture: {
    captureConversationTurn(opts: {
      role: "user" | "assistant" | "system";
      content: string;
      conversationId: string;
      messageId: string;
      timestamp?: string;
    }): Promise<{ inserted: boolean; record: import("./types.js").ExperienceRecord }>;

    captureNote(opts: {
      text: string;
      noteId?: string;
      tags?: string[];
      timestamp?: string;
    }): Promise<{ inserted: boolean; record: import("./types.js").ExperienceRecord }>;

    captureExternal(
      opts: Parameters<typeof buildExternalRecord>[0],
    ): Promise<{ inserted: boolean; record: import("./types.js").ExperienceRecord }>;

    captureMarkdown(opts: {
      path: string;
      raw: string;
      mtime?: string;
      title?: string;
    }): Promise<{ inserted: boolean; record: import("./types.js").ExperienceRecord }>;

    captureDocument(opts: {
      path: string;
      text: string;
      title?: string;
      mtime?: string;
      ext?: string;
    }): Promise<{ docId: string; skipped: boolean; inserted: number; total: number }>;
  };

  store: MemoryStore;

  retrieval: {
    retrieve(query: string, opts?: RetrievalOptions): Promise<RetrievedMemory[]>;
    getProceduralBlock(): string;
  };

  consolidation: {
    run(trigger?: "scheduler" | "manual"): Promise<ConsolidationResult>;
  };

  profile: ProfileService;
}

/**
 * Create a fully wired MemorySystem.
 *
 * @param config.embedder  Embedding model interface (FakeEmbedder for tests).
 * @param config.llm       LLM interface for AI stages (FakeLlm for tests).
 * @param config.dataDir   Directory for the SQLite DB file (created if needed).
 */
export function createMemorySystem(config: MemorySystemConfig): MemorySystem {
  const db = openDatabase(config.dataDir);
  const store = new MemoryStore(db, config.embedder);
  const captureService = new CaptureService(store, config.embedder);
  const retrievalService = new RetrievalService(store, config.embedder, undefined, config.reranker);
  const consolidationService = new ConsolidationService(store, config.llm, config.embedder);
  const profileService = new ProfileService(store, config.llm);

  return {
    capture: {
      captureConversationTurn: (opts) => captureService.captureConversationTurn(opts),
      captureNote: (opts) => captureService.captureNote(opts),
      captureExternal: (opts) => captureService.captureExternal(opts),
      captureMarkdown: (opts) => captureService.captureMarkdown(opts),
      captureDocument: (opts) => captureService.captureDocument(opts),
    },
    store,
    retrieval: {
      retrieve: (query, opts) => retrievalService.retrieve(query, opts),
      getProceduralBlock: () => retrievalService.getProceduralBlock(),
    },
    consolidation: {
      run: (trigger) => consolidationService.run(trigger),
    },
    profile: profileService,
  };
}
