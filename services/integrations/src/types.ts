/**
 * Shared types for @jarvis/integrations — features 9, 10, 12, 13, 15.
 *
 * All timestamps are UTC ISO-8601 strings.
 * MetricPoint IDs are deterministic hashes (makeMetricId).
 */

// ── Source IDs ────────────────────────────────────────────────────────────────

export type SourceId =
  | "apple_health"
  | "whoop"
  | "gcal"
  | "github"
  | "gmail"
  | "simplefin";

export type AuthKind = "oauth" | "pat" | "push";

// ── MetricPoint / MetricSeries ────────────────────────────────────────────────

export interface MetricPoint {
  /** Deterministic hash: makeMetricId(source, metric, ts, dims). */
  id: string;
  source: SourceId;
  metric: string;          // e.g. 'sleep.duration_min', 'hrv', 'commits'
  value: number;
  unit: string;            // 'min' | 'ms' | 'count' | 'bpm' | '%' | ...
  ts: string;              // UTC ISO-8601 (the instant the value pertains to)
  dims?: Record<string, string>; // e.g. {repo:'jarvis', stage:'rem'}
  ingestedAt: string;      // UTC ISO-8601
  adapterVersion: string;  // bump to invalidate/reprocess
}

export interface MetricSeries {
  metric: string;
  unit: string;
  agg?: { fn: string; bucket: string } | null;
  points: Array<{ ts: string; value: number; dims?: Record<string, string> }>;
}

// ── Cursor ────────────────────────────────────────────────────────────────────

export interface Cursor {
  source: SourceId;
  stream: string;
  highWater: string;       // last fetched ts or opaque page token
  pageToken?: string | null;
  updatedAt: string;
}

// ── SyncRun ───────────────────────────────────────────────────────────────────

export interface SyncRun {
  id: string;
  source: SourceId;
  stream: string;
  trigger: "schedule" | "manual" | "webhook" | "push";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "partial" | "error";
  pointsWritten: number;
  pagesFetched: number;
  error?: { code: string; message: string; retryable: boolean } | null;
  cursorBefore?: string | null;
  cursorAfter?: string | null;
}

// ── Connector interface ───────────────────────────────────────────────────────

/**
 * The result of one connector sync pass.
 *
 * @property points      Normalized metric points to upsert (idempotent by `id`).
 * @property events      Optional calendar events to mirror (Google Calendar only).
 * @property nextCursor  High-water mark to persist so the next run resumes where
 *   this one stopped, or `null` to leave the cursor unchanged (nothing new). The
 *   Scheduler advances the cursor ONLY after points/events are persisted, so a
 *   connector that throws leaves the cursor untouched and the window is retried.
 */
export interface ConnectorSyncResult {
  points: MetricPoint[];
  events?: CalendarEvent[];
  nextCursor: string | null;
}

/**
 * A data source connector.
 *
 * Implementing one is intentionally small: the repetitive work (auth, pagination,
 * point construction) lives in shared framework helpers, so a connector mostly
 * describes WHAT to fetch and how to normalize it. See the step-by-step guide in
 * `services/integrations/CONNECTORS.md`.
 *
 * Inside `sync()`, reach for:
 *   - `getOAuthAccessToken(source, tokenStore, http)` — auth for OAuth catalog sources
 *   - `fetchAllPages(fetchPage, maxPages)`            — token-based pagination
 *   - `metricPointFactory(source)`                    — build MetricPoints
 */
export interface Connector {
  /** Stable source identifier; also the TokenStore and cursor key. */
  id: SourceId;
  /** How this source authenticates: OAuth2, personal access token, or push. */
  auth: AuthKind;
  /** Cron expression for scheduled polling (e.g. '0 5 * * *'). */
  schedule: string;
  /**
   * Max concurrent sync runs. MUST be 1 for sources with rotating refresh tokens
   * (Whoop) so concurrent refreshes cannot invalidate each other.
   */
  concurrency: number;
  /**
   * Fetch new data since `cursor`, normalize it, and return the points to store
   * plus the next cursor. Throw to fail the run WITHOUT advancing the cursor —
   * the Scheduler records an error run and retries the same window next time.
   */
  sync(
    cursor: Cursor | null,
    http: HttpClient,
    tokenStore: TokenStore
  ): Promise<ConnectorSyncResult>;
}

// ── CalendarEvent ─────────────────────────────────────────────────────────────

export type EventStatus = "confirmed" | "tentative" | "cancelled";
export type AttendeeResponse = "accepted" | "declined" | "tentative" | "needsAction";

export interface EventTime {
  dateTime?: string;      // UTC ISO-8601 (timed events)
  date?: string;          // YYYY-MM-DD (all-day events)
  timeZone: string;       // IANA timezone
}

export interface Attendee {
  email: string;
  displayName?: string;
  response: AttendeeResponse;
  self: boolean;
  organizer: boolean;
}

export interface CalendarEvent {
  calendarId: string;
  id: string;             // Google event id
  etag: string;
  status: EventStatus;
  summary: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: EventTime;
  attendees: Attendee[];
  organizer?: { email: string; self: boolean };
  created: string;        // UTC ISO
  updated: string;        // UTC ISO
  source: "google";
  syncedAt: string;       // UTC ISO
}

export interface FreeBusySlot {
  start: string;          // UTC ISO
  end: string;            // UTC ISO
  state: "busy" | "free";
  source?: string;
}

// ── EventWriteRequest / WriteResult ───────────────────────────────────────────

export interface EventWriteRequest {
  requestId: string;
  op: "create" | "update" | "delete";
  calendarId: string;
  eventId?: string;
  ifMatchEtag?: string;
  patch?: Partial<{
    summary: string;
    description: string;
    location: string;
    start: EventTime;
    end: EventTime;
    attendees: { email: string }[];
    recurrence: string[];
  }>;
  reason: string;
  allowConflict?: boolean;
}

export interface WriteResult {
  requestId: string;
  ok: boolean;
  op: EventWriteRequest["op"];
  event?: CalendarEvent;
  conflicts?: FreeBusySlot[];
  error?: { code: number; reason: string; retryable: boolean };
  approvedAt?: string;
}

// ── Todo ──────────────────────────────────────────────────────────────────────

export interface Todo {
  id: string;
  text: string;
  due?: string;           // ISO; absent = no due date
  status: "open" | "done";
  source: "user" | "agent";
  links?: { type: "github" | "gmail" | "note"; url: string }[];
  createdAt: string;
  completedAt?: string;
  recurrence?: "daily" | "weekly" | "weekdays" | null;
  snoozedCount?: number;
}

// ── BriefingDoc ───────────────────────────────────────────────────────────────

export interface SleepInput {
  score: number;
  /** Hours slept; null = no sleep-duration data (recovery may still exist). */
  hoursSlept: number | null;
  recovery: "low" | "ok" | "high";
  source: { feature: string; gatheredAt: string; stale: boolean };
}

export interface AgendaInput {
  events: { time: string; title: string; key: boolean }[];
  source: { feature: string; gatheredAt: string; stale: boolean };
}

export interface TodoInput {
  dueToday: { title: string; priority: "high" | "med" | "low" }[];
  source: { feature: string; gatheredAt: string; stale: boolean };
}

export interface InsightInput {
  digest: string[];
  source: { feature: string; gatheredAt: string; stale: boolean };
}

export interface BriefingContext {
  date: string;           // YYYY-MM-DD
  sleep: SleepInput | null;
  agenda: AgendaInput | null;
  todos: TodoInput | null;
  insights: InsightInput | null;
}

export interface BriefingDoc {
  id: string;
  date: string;
  context: BriefingContext;
  generatedBy: "llm" | "template";
  status: "generating" | "ready" | "error" | "empty";
  createdAt: string;
  markdown: string;
  ttsText?: string;
}

// ── Injected interfaces (DI) ──────────────────────────────────────────────────

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Clock {
  now(): number; // Unix timestamp ms
}

export interface TokenStore {
  get(source: SourceId): Promise<OAuthTokens | null>;
  set(source: SourceId, tokens: OAuthTokens): Promise<void>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix ms
  scope?: string;
}

export interface LlmClient {
  complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
  }): Promise<string>;
}

// ── WorkEvent ─────────────────────────────────────────────────────────────────

export interface WorkEvent {
  id: string;
  source: "github" | "gmail";
  type:
    | "commit"
    | "pr_opened"
    | "pr_merged"
    | "pr_reviewed"
    | "review_comment"
    | "issue_opened"
    | "issue_closed"
    | "email_received"
    | "email_sent"
    | "email_unread_snapshot";
  ts: string;             // ISO 8601 UTC
  repo?: string;
  title?: string;
  url?: string;
  thread?: string;
  meta?: Record<string, unknown>;
}
