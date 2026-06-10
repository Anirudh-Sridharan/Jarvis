/**
 * @jarvis/integrations — public API.
 *
 * createIntegrations({ http, clock, tokenStore, llm, dataDir }) returns:
 *   {
 *     connectors:  ConnectorRegistry
 *     metrics:     MetricStore
 *     todos:       TodoStore
 *     calendar:    CalendarMirror + findFreeTime + detectConflicts
 *     briefing:    BriefingService
 *     scheduler:   Scheduler
 *   }
 *
 * All external I/O is behind injected interfaces (HttpClient, Clock, TokenStore,
 * LlmClient). Use fakes from @jarvis/integrations/testing for tests.
 *
 * NOTE: Finance (feature 11) is DEFERRED to v2 — not implemented here.
 * TODO(future): share ConnectorRegistry with @jarvis/memory (feature 3 connectors).
 */

import { openDatabase } from "./db/database.js";
import { ConnectorRegistry } from "./framework/registry.js";
import { MetricStore } from "./framework/metricStore.js";
import { Scheduler } from "./framework/scheduler.js";
import { BriefingService } from "./briefing/briefing.js";
import { TodoStore } from "./work/todos.js";
import {
  CalendarMirror,
  findFreeTime,
  detectConflicts,
  createEvent,
} from "./connectors/googleCalendar.js";
import { whoopConnector } from "./connectors/whoop.js";
import { appleHealthConnector, createPushEndpointHandler } from "./connectors/appleHealth.js";
import { googleCalendarConnector } from "./connectors/googleCalendar.js";
import { githubConnector } from "./connectors/github.js";
import { gmailConnector } from "./connectors/gmail.js";

import type {
  HttpClient,
  Clock,
  TokenStore,
  LlmClient,
} from "./types.js";

// ── Public re-exports ──────────────────────────────────────────────────────────

export type {
  MetricPoint,
  MetricSeries,
  Connector,
  ConnectorSyncResult,
  Cursor,
  SyncRun,
  CalendarEvent,
  EventTime,
  Attendee,
  AttendeeResponse,
  FreeBusySlot,
  EventWriteRequest,
  WriteResult,
  Todo,
  BriefingDoc,
  BriefingContext,
  SleepInput,
  AgendaInput,
  TodoInput,
  InsightInput,
  HttpClient,
  HttpRequest,
  HttpResponse,
  Clock,
  TokenStore,
  OAuthTokens,
  LlmClient,
  SourceId,
  WorkEvent,
} from "./types.js";

export { makeMetricId } from "./framework/metricStore.js";
export { MetricStore } from "./framework/metricStore.js";
export { ConnectorRegistry } from "./framework/registry.js";
export { Scheduler, isDue } from "./framework/scheduler.js";
export { TodoStore, computeNextDue } from "./work/todos.js";
export { BriefingService, renderTemplateBrief } from "./briefing/briefing.js";
export {
  CalendarMirror,
  normalizeCalendarEvent,
  findFreeTime,
  detectConflicts,
  createEvent,
  busyIntervals,
} from "./connectors/googleCalendar.js";
export {
  normalizeWhoopRecovery,
  normalizeWhoopSleep,
  normalizeWhoopCycle,
} from "./connectors/whoop.js";
export {
  ingestAppleHealth,
  createPushEndpointHandler,
} from "./connectors/appleHealth.js";
export {
  workEventsToMetricPoints,
} from "./connectors/github.js";
export {
  normalizeGmailMessage,
  gmailEventsToMetricPoints,
} from "./connectors/gmail.js";
export {
  getAccessToken,
  clearOAuthState,
} from "./framework/oauth.js";

// ── Factory ───────────────────────────────────────────────────────────────────

export interface IntegrationsConfig {
  http: HttpClient;
  clock: Clock;
  tokenStore: TokenStore;
  llm: LlmClient;
  dataDir: string;
}

export interface IntegrationsSystem {
  connectors: ConnectorRegistry;
  metrics: MetricStore;
  todos: TodoStore;
  calendar: {
    mirror: CalendarMirror;
    findFreeTime: typeof findFreeTime;
    detectConflicts: typeof detectConflicts;
    createEvent: typeof createEvent;
  };
  briefing: BriefingService;
  scheduler: Scheduler;
  /** Apple Health push endpoint handler factory. */
  createAppleHealthHandler: typeof createPushEndpointHandler;
}

/**
 * Create a fully wired IntegrationsSystem.
 *
 * @param config.http        HTTP client (FakeHttp for tests, real fetch wrapper for prod)
 * @param config.clock       Clock interface (FixedClock for tests)
 * @param config.tokenStore  OAuth token storage (MemoryTokenStore for tests)
 * @param config.llm         LLM client for briefing generation (FakeLlm for tests)
 * @param config.dataDir     Directory for SQLite DB (created if absent)
 */
export function createIntegrations(config: IntegrationsConfig): IntegrationsSystem {
  const db = openDatabase(config.dataDir);
  const metrics = new MetricStore(db);
  const todos = new TodoStore(db);
  const calendarMirror = new CalendarMirror(db);
  const scheduler = new Scheduler(db, metrics, config.clock);
  const briefing = new BriefingService(metrics, calendarMirror, todos, config.llm);

  // Register default connectors
  const connectors = new ConnectorRegistry();
  connectors.register(whoopConnector);
  connectors.register(appleHealthConnector);
  connectors.register(googleCalendarConnector);
  connectors.register(githubConnector);
  connectors.register(gmailConnector);

  return {
    connectors,
    metrics,
    todos,
    calendar: {
      mirror: calendarMirror,
      findFreeTime,
      detectConflicts,
      createEvent,
    },
    briefing,
    scheduler,
    createAppleHealthHandler: createPushEndpointHandler,
  };
}
