/**
 * Capture pipeline: dedup → journal → embed (immediate/deferred) → store → tag consolidation_pending.
 *
 * This is the deterministic intake layer (feature 3). No LLM is called here.
 * The text is embedded using the injected Embedder (for immediate records).
 * Large/deferred records are flagged `embed_state=deferred` and embedded in
 * the nightly consolidation pass.
 */

import { createHash } from "node:crypto";
import type { ExperienceRecord, Embedder } from "../types.js";
import { buildExternalRecord } from "./experience.js";
import type { ChunkOptions } from "./chunk.js";
import type { MemoryStore } from "../store/memoryStore.js";

/** Token-length threshold: texts above this are flagged as deferred. */
const DEFER_THRESHOLD_CHARS = 2048; // ~512 tokens

export interface CaptureResult {
  inserted: boolean; // false = duplicate, dropped
  record: ExperienceRecord;
}

export class CaptureService {
  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
  ) {}

  /**
   * Capture an ExperienceRecord:
   * 1. Dedup (drop if dedup_key already exists)
   * 2. Journal (insert into experience_records)
   * 3. Embed immediately if short; otherwise flag deferred
   * 4. Tag consolidation_pending=true (already set by builders)
   */
  async capture(record: ExperienceRecord): Promise<CaptureResult> {
    const inserted = this.store.insertExperienceIfNew(record);
    if (!inserted) {
      return { inserted: false, record };
    }

    // Decide embed strategy
    if (record.text.length <= DEFER_THRESHOLD_CHARS) {
      // Embed immediately and persist the vector
      try {
        const [vec] = await this.embedder.embed([record.text]);
        if (vec) {
          this.store.upsertEmbedding(record.id, "experience", vec);
          this.store.updateExperienceEmbedState(record.id, "done");
        }
        // No vector returned (embedder unavailable) — stays pending
      } catch {
        // Non-fatal — stays pending
      }
    } else {
      this.store.updateExperienceEmbedState(record.id, "deferred");
    }

    return { inserted: true, record };
  }

  /** Capture a conversation turn (user or assistant). */
  async captureConversationTurn(opts: {
    role: "user" | "assistant" | "system";
    content: string;
    conversationId: string;
    messageId: string;
    timestamp?: string;
  }): Promise<CaptureResult> {
    const { buildConversationRecord } = await import("./experience.js");
    const record = buildConversationRecord(opts);
    return this.capture(record);
  }

  /** Capture a quick-capture note. */
  async captureNote(opts: {
    text: string;
    noteId?: string;
    tags?: string[];
    timestamp?: string;
  }): Promise<CaptureResult> {
    const { buildNoteRecord } = await import("./experience.js");
    const record = buildNoteRecord(opts);
    return this.capture(record);
  }

  /** Capture an external/connector item (calendar event, health/work digest). */
  async captureExternal(
    opts: Parameters<typeof buildExternalRecord>[0],
  ): Promise<CaptureResult> {
    return this.capture(buildExternalRecord(opts));
  }

  /**
   * Capture a markdown / Obsidian note (second-brain vault ingest). Long notes
   * are chunked into multiple records; short notes stay a single record. The
   * returned `inserted` is true when ≥1 new record was journaled (so the vault
   * ingester's per-note counting is unchanged); `total`/`insertedCount` report
   * the chunk breakdown.
   */
  async captureMarkdown(opts: {
    path: string;
    raw: string;
    mtime?: string;
    title?: string;
  }): Promise<{ inserted: boolean; total: number; insertedCount: number }> {
    const { buildMarkdownRecords } = await import("./adapters/markdown.js");
    const records = buildMarkdownRecords(opts);
    let insertedCount = 0;
    for (const record of records) {
      const res = await this.capture(record);
      if (res.inserted) insertedCount++;
    }
    return { inserted: insertedCount > 0, total: records.length, insertedCount };
  }

  /**
   * Capture a document (PDF / text / doc) as chunked memory records.
   *
   * Two-tier dedup: a fast doc-level skip on `doc_id` (sha256 of the extracted
   * text) avoids re-chunking an unchanged file; per-chunk dedup_key uniqueness
   * is the correctness backstop. Returns the per-document tally; `inserted` is
   * the count of newly-journaled chunks (unchanged chunks drop as duplicates).
   */
  async captureDocument(opts: {
    path: string;
    text: string;
    title?: string;
    mtime?: string;
    ext?: string;
    chunkOpts?: ChunkOptions;
  }): Promise<{ docId: string; skipped: boolean; inserted: number; total: number }> {
    const docId = createHash("sha256").update(opts.text).digest("hex");
    if (this.store.documentExists(docId)) {
      return { docId, skipped: true, inserted: 0, total: 0 };
    }

    const { buildDocumentChunkRecords } = await import("./adapters/document.js");
    const records = buildDocumentChunkRecords({ ...opts, docId });
    let inserted = 0;
    for (const record of records) {
      const res = await this.capture(record);
      if (res.inserted) inserted++;
    }
    return { docId, skipped: false, inserted, total: records.length };
  }
}
