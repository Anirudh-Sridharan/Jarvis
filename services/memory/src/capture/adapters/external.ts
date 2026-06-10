/**
 * External source adapter interface (mostly historical).
 *
 * The LIVE path for external data → memory is core's ingest bridge
 * (services/core/src/memory/ingestBridge.ts): feature 9's connector framework
 * fetches calendar/health/work data into its own stores, and the bridge
 * converts recent windows into ExperienceRecords via capture.captureExternal
 * (idempotent — content-hash dedup). This interface remains for a future
 * per-item streaming adapter (e.g. Gmail users.watch webhooks) if digests
 * prove too coarse.
 */

import type { ExperienceRecord } from "../../types.js";

/**
 * SourceAdapter interface — each external connector implements this.
 * In v1, only conversation and note adapters are implemented.
 */
export interface SourceAdapter<Raw = unknown> {
  id: string;
  auth: "none" | "oauth2" | "pat" | "push";
  defaultEnabled: true;
  schedule?: string; // cron string
  supportsWebhook: boolean;
  /** Incremental pull since cursor. */
  fetch(cursor: Cursor | null): AsyncIterable<Raw>;
  /** For push sources (Apple Health). */
  ingestPush?(body: unknown): AsyncIterable<Raw>;
  /** Deterministic, no LLM. */
  normalize(raw: Raw): ExperienceRecord[];
  nextCursor(raw: Raw, prev: Cursor | null): Cursor;
}

export interface Cursor {
  value: string;
  updated_at: string;
}
