/**
 * External source adapter STUB.
 *
 * TODO(phase4: feature 9) implement full connector adapters for:
 *   - Gmail (OAuth2, historyId incremental, users.watch webhook)
 *   - Google Calendar (OAuth2, syncToken, push channel)
 *   - GitHub (PAT, ETag + since)
 *   - Apple Health (push: ingestPush() from local REST endpoint)
 *   - Whoop (OAuth2 rotating-refresh, serialized via withWhoopRefreshLock)
 *
 * These adapters share the connector/auth layer with feature 9 (data integration
 * framework). Outputs diverge: ExperienceRecord (here) vs metric series (feature 9).
 *
 * Auth pattern (Whoop): all refreshes go through a single serialized critical section
 * to avoid burning the rotating refresh token. See architecture/auth-and-integrations.md.
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
