/**
 * Capture pipeline: dedup → journal → embed (immediate/deferred) → store → tag consolidation_pending.
 *
 * This is the deterministic intake layer (feature 3). No LLM is called here.
 * The text is embedded using the injected Embedder (for immediate records).
 * Large/deferred records are flagged `embed_state=deferred` and embedded in
 * the nightly consolidation pass.
 */

import type { ExperienceRecord, Embedder } from "../types.js";
import { buildExternalRecord } from "./experience.js";
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
}
