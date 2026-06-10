/**
 * ExperienceRecord builders and dedup_key computation.
 *
 * Dedup rule: source + native_source_id + sha256(canonicalized_content).
 * This kills webhook+batch overlap and re-run duplicates.
 */

import { createHash } from "node:crypto";
import type { ExperienceRecord, SourceId, ExperienceType, CaptureEntity } from "../types.js";
import { newId } from "../db/database.js";

/** Stable JSON: sorted keys, no whitespace — re-emits hash identically. */
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Compute the deterministic dedup_key for a record. */
export function computeDedupKey(
  source: SourceId,
  nativeId: string,
  content: unknown,
): string {
  const hash = createHash("sha256").update(canonicalize(content)).digest("hex");
  return `${source}:${nativeId}:sha256:${hash}`;
}

/** Build an ExperienceRecord for a conversation turn. */
export function buildConversationRecord(opts: {
  role: "user" | "assistant" | "system";
  content: string;
  conversationId: string;
  messageId: string;
  timestamp?: string;
  entities?: CaptureEntity[];
}): ExperienceRecord {
  const now = new Date().toISOString();
  const nativeId = opts.messageId;
  const source: SourceId = "conversation";
  return {
    id: newId(),
    source,
    type: "message",
    timestamp: opts.timestamp ?? now,
    ingested_at: now,
    actor: opts.role,
    text: `[${opts.role}] ${opts.content}`,
    payload: {
      role: opts.role,
      content: opts.content,
      conversation_id: opts.conversationId,
      message_id: opts.messageId,
    },
    entities: opts.entities ?? [],
    provenance: {
      adapter: source,
      adapter_version: "1.0.0",
      via: "in_process",
      source_id: nativeId,
      cursor_at: now,
    },
    raw_ref: `raw/conversation/${opts.conversationId}/${nativeId}.json`,
    dedup_key: computeDedupKey(source, nativeId, opts.content),
    embed_state: "pending", // short text → embed immediately
    sync_state: "pending",
    consolidation_pending: true,
  };
}

/** Build an ExperienceRecord for a quick-capture note. */
export function buildNoteRecord(opts: {
  text: string;
  noteId?: string;
  tags?: string[];
  timestamp?: string;
}): ExperienceRecord {
  const now = new Date().toISOString();
  const nativeId = opts.noteId ?? newId();
  const source: SourceId = "note";
  const entities: CaptureEntity[] = (opts.tags ?? []).map((t) => ({
    kind: "tag" as const,
    value: t,
  }));
  return {
    id: newId(),
    source,
    type: "note",
    timestamp: opts.timestamp ?? now,
    ingested_at: now,
    actor: "user",
    text: opts.text,
    payload: {
      note_id: nativeId,
      tags: opts.tags ?? [],
    },
    entities,
    provenance: {
      adapter: source,
      adapter_version: "1.0.0",
      via: "in_process",
      source_id: nativeId,
      cursor_at: now,
    },
    raw_ref: `raw/note/${nativeId}.json`,
    dedup_key: computeDedupKey(source, nativeId, opts.text),
    embed_state: "pending",
    sync_state: "pending",
    consolidation_pending: true,
  };
}

/**
 * Build an ExperienceRecord for an external/connector item (feature 9 →
 * feature 3 bridge): calendar events, health digests, work digests, etc.
 * Content-hash dedup: pass the fields whose change should re-capture the
 * item (e.g. a calendar event's etag/times) as `content`.
 */
export function buildExternalRecord(opts: {
  source: Exclude<SourceId, "conversation" | "note">;
  type: ExperienceType;
  nativeId: string;
  text: string;
  timestamp: string;
  actor?: string;
  payload?: Record<string, unknown>;
  entities?: CaptureEntity[];
  /** Fields hashed into the dedup key; defaults to `text`. */
  content?: unknown;
}): ExperienceRecord {
  const now = new Date().toISOString();
  return {
    id: newId(),
    source: opts.source,
    type: opts.type,
    timestamp: opts.timestamp,
    ingested_at: now,
    actor: opts.actor ?? opts.source,
    text: opts.text,
    payload: opts.payload ?? {},
    entities: opts.entities ?? [],
    provenance: {
      adapter: opts.source,
      adapter_version: "1.0.0",
      via: "in_process",
      source_id: opts.nativeId,
      cursor_at: now,
    },
    raw_ref: `raw/${opts.source}/${opts.nativeId}.json`,
    dedup_key: computeDedupKey(opts.source, opts.nativeId, opts.content ?? opts.text),
    embed_state: "pending",
    sync_state: "pending",
    consolidation_pending: true,
  };
}
