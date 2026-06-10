/**
 * Google Calendar connector — OAuth2, incremental sync with syncToken + 410 resync.
 *
 * Read path:
 *   - Incremental: events.list({ syncToken }) — pages through nextPageToken
 *   - On 410 Gone: discard syncToken, do bounded full resync (now−30d to now+365d)
 *   - syncToken advanced ONLY after mirror upsert commits (cursor discipline)
 *   - Cancelled events → tombstone
 *
 * Write path:
 *   - executeEventWrite (create/update/delete) / findFreeTime
 *   - validate → conflict-detect (mirror) → Google API → reconcile mirror.
 *     Approval is upstream: the agent ReAct loop gates readOnly:false tools
 *     (feature 17) before tool.run() ever calls this.
 *
 * Calendar events are normalized to CalendarEvent and stored in the local mirror.
 * Events are also converted to MetricPoints (event count per day) for dashboard.
 */

import type {
  Connector,
  ConnectorSyncResult,
  Cursor,
  HttpClient,
  HttpResponse,
  MetricPoint,
  CalendarEvent,
  EventTime,
  Attendee,
  AttendeeResponse,
  TokenStore,
  FreeBusySlot,
  EventWriteRequest,
  WriteResult,
} from "../types.js";
import { makeMetricId } from "../framework/metricStore.js";
import { getAccessToken } from "../framework/oauth.js";
import { getRefreshConfig } from "../framework/providers.js";
import type { DatabaseSync } from "node:sqlite";
import { toJson, fromJson } from "../db/database.js";

const ADAPTER_VERSION = "1";
const RESYNC_WINDOW_DAYS = 30;

export const googleCalendarConnector: Connector = {
  id: "gcal",
  auth: "oauth",
  schedule: "0 * * * *", // hourly poll (safety net; push channel provides freshness)
  concurrency: 2,

  async sync(
    cursor: Cursor | null,
    http: HttpClient,
    tokenStore: TokenStore
  ): Promise<ConnectorSyncResult> {
    const token = await getAccessToken("gcal", tokenStore, http, getRefreshConfig("gcal"));
    const calendarId = "primary";

    // The cursor stores the syncToken in highWater
    let syncToken: string | null = cursor?.highWater ?? null;
    const events: CalendarEvent[] = [];
    const points: MetricPoint[] = [];
    let nextSyncToken: string | null = null;

    // Sync loop: may restart once on 410
    let isFullResync = !syncToken;
    let attempts = 0;

    while (attempts < 2) {
      attempts++;
      let pageToken: string | undefined = undefined;
      let got410 = false;

      while (true) {
        const params = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "false" });
        if (syncToken && !isFullResync) {
          params.set("syncToken", syncToken);
        } else {
          params.set("timeMin", resyncFloor());
          params.set("timeMax", resyncCeil());
        }
        if (pageToken) params.set("pageToken", pageToken);

        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
        const res = await http.request({
          method: "GET",
          url,
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 410 && !isFullResync) {
          // syncToken stale → full resync
          syncToken = null;
          isFullResync = true;
          got410 = true;
          break; // restart outer loop
        }

        if (res.status !== 200) {
          throw new Error(`Calendar sync failed: HTTP ${res.status}`);
        }

        const data = res.body as {
          items?: RawGoogleEvent[];
          nextPageToken?: string;
          nextSyncToken?: string;
        };

        for (const raw of data.items ?? []) {
          const event = normalizeCalendarEvent(calendarId, raw);
          events.push(event);
          if (event.status !== "cancelled") {
            points.push(eventToMetricPoint(event));
          }
        }

        pageToken = data.nextPageToken;
        if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
        if (!pageToken) break; // done paging
      }

      if (!got410) break; // successful sync, exit outer loop
    }

    return {
      points,
      events,
      nextCursor: nextSyncToken, // advance cursor LAST (caller's responsibility via Scheduler)
    };
  },
};

// ── Types for raw Google Calendar API responses ───────────────────────────────

interface RawGoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }>;
  organizer?: { email?: string; self?: boolean };
  created?: string;
  updated?: string;
}

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Normalize an RFC3339 dateTime to UTC ISO ("Z"). Google returns dateTimes in
 * the calendar's local offset; the mirror compares start_json.dateTime as a
 * STRING (json_extract range filters), so all stored dateTimes MUST share one
 * representation or lexicographic order diverges from instant order — which
 * silently drops events from conflict-detection and agenda windows.
 */
function toUtcIso(dateTime: string | undefined): string | undefined {
  if (!dateTime) return undefined;
  const ms = Date.parse(dateTime);
  return Number.isNaN(ms) ? dateTime : new Date(ms).toISOString();
}

export function normalizeCalendarEvent(
  calendarId: string,
  raw: RawGoogleEvent
): CalendarEvent {
  const now = new Date().toISOString();
  const startRaw = raw.start ?? {};
  const endRaw = raw.end ?? {};

  const start: EventTime = {
    dateTime: toUtcIso(startRaw.dateTime),
    date: startRaw.date,
    timeZone: startRaw.timeZone ?? "UTC",
  };
  const end: EventTime = {
    dateTime: toUtcIso(endRaw.dateTime),
    date: endRaw.date,
    timeZone: endRaw.timeZone ?? "UTC",
  };

  const allDay = !startRaw.dateTime && !!startRaw.date;

  const attendees: Attendee[] = (raw.attendees ?? []).map((a) => ({
    email: a.email ?? "",
    displayName: a.displayName,
    response: (a.responseStatus ?? "needsAction") as AttendeeResponse,
    self: !!a.self,
    organizer: !!a.organizer,
  }));

  return {
    calendarId,
    id: raw.id ?? "",
    etag: raw.etag ?? "",
    status: (raw.status ?? "confirmed") as CalendarEvent["status"],
    summary: raw.summary ?? "",
    description: raw.description,
    location: raw.location,
    start,
    end,
    allDay,
    recurrence: raw.recurrence,
    recurringEventId: raw.recurringEventId,
    originalStartTime: raw.originalStartTime
      ? {
          dateTime: toUtcIso(raw.originalStartTime.dateTime),
          date: raw.originalStartTime.date,
          timeZone: raw.originalStartTime.timeZone ?? "UTC",
        }
      : undefined,
    attendees,
    organizer: raw.organizer
      ? { email: raw.organizer.email ?? "", self: !!raw.organizer.self }
      : undefined,
    created: raw.created ?? now,
    updated: raw.updated ?? now,
    source: "google",
    syncedAt: now,
  };
}

export function eventToMetricPoint(event: CalendarEvent): MetricPoint {
  // Use start date as ts for event count bucketing.
  // dims include the event id: two events starting at the same instant must
  // NOT collide into one point (concurrent meetings would undercount).
  const ts =
    event.start.dateTime ?? `${event.start.date ?? ""}T00:00:00Z`;
  const now = new Date().toISOString();
  const dims = { calendarId: event.calendarId, eventId: event.id };
  return {
    id: makeMetricId({ source: "gcal", metric: "calendar.event_count", ts, dims }),
    source: "gcal",
    metric: "calendar.event_count",
    value: 1,
    unit: "count",
    ts,
    dims,
    ingestedAt: now,
    adapterVersion: ADAPTER_VERSION,
  };
}

// ── Calendar mirror (SQLite) ───────────────────────────────────────────────────

export class CalendarMirror {
  constructor(private db: DatabaseSync) {}

  upsertEvent(event: CalendarEvent): void {
    this.db
      .prepare(
        `INSERT INTO calendar_events
           (calendar_id, id, etag, status, summary, description, location,
            start_json, end_json, all_day, recurrence, recurring_event_id,
            original_start_time, attendees, organizer, created, updated, synced_at)
         VALUES
           (:calendar_id, :id, :etag, :status, :summary, :description, :location,
            :start_json, :end_json, :all_day, :recurrence, :recurring_event_id,
            :original_start_time, :attendees, :organizer, :created, :updated, :synced_at)
         ON CONFLICT(calendar_id, id) DO UPDATE SET
           etag                = excluded.etag,
           status              = excluded.status,
           summary             = excluded.summary,
           description         = excluded.description,
           location            = excluded.location,
           start_json          = excluded.start_json,
           end_json            = excluded.end_json,
           all_day             = excluded.all_day,
           recurrence          = excluded.recurrence,
           recurring_event_id  = excluded.recurring_event_id,
           original_start_time = excluded.original_start_time,
           attendees           = excluded.attendees,
           organizer           = excluded.organizer,
           updated             = excluded.updated,
           synced_at           = excluded.synced_at`
      )
      .run({
        calendar_id: event.calendarId,
        id: event.id,
        etag: event.etag,
        status: event.status,
        summary: event.summary,
        description: event.description ?? null,
        location: event.location ?? null,
        start_json: toJson(event.start),
        end_json: toJson(event.end),
        all_day: event.allDay ? 1 : 0,
        recurrence: event.recurrence ? toJson(event.recurrence) : null,
        recurring_event_id: event.recurringEventId ?? null,
        original_start_time: event.originalStartTime ? toJson(event.originalStartTime) : null,
        attendees: toJson(event.attendees),
        organizer: event.organizer ? toJson(event.organizer) : null,
        created: event.created,
        updated: event.updated,
        synced_at: event.syncedAt,
      });
  }

  tombstoneEvent(calendarId: string, eventId: string): void {
    this.db
      .prepare(
        `UPDATE calendar_events SET status = 'cancelled', synced_at = ?
         WHERE calendar_id = ? AND id = ?`
      )
      .run(new Date().toISOString(), calendarId, eventId);
  }

  getEvents(calendarId: string, from: string, to: string): CalendarEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM calendar_events
         WHERE calendar_id = ?
           AND status != 'cancelled'
           AND (
             (all_day = 0 AND start_json LIKE '%"dateTime"%' AND
              json_extract(start_json, '$.dateTime') >= ? AND
              json_extract(start_json, '$.dateTime') <= ?)
             OR
             (all_day = 1 AND start_json LIKE '%"date"%' AND
              json_extract(start_json, '$.date') >= ? AND
              json_extract(start_json, '$.date') <= ?)
           )
         ORDER BY start_json ASC`
      )
      .all(calendarId, from, to, from.slice(0, 10), to.slice(0, 10)) as Record<string, unknown>[];

    return rows.map(rowToEvent);
  }

  saveSyncToken(calendarId: string, token: string): void {
    this.db
      .prepare(
        `INSERT INTO calendar_sync_tokens (calendar_id, sync_token, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(calendar_id) DO UPDATE SET
           sync_token = excluded.sync_token,
           updated_at = excluded.updated_at`
      )
      .run(calendarId, token, new Date().toISOString());
  }

  loadSyncToken(calendarId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT sync_token FROM calendar_sync_tokens WHERE calendar_id = ?`
      )
      .get(calendarId) as { sync_token: string | null } | undefined;
    return row?.sync_token ?? null;
  }

  clearSyncToken(calendarId: string): void {
    this.db
      .prepare(`DELETE FROM calendar_sync_tokens WHERE calendar_id = ?`)
      .run(calendarId);
  }
}

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    calendarId: row["calendar_id"] as string,
    id: row["id"] as string,
    etag: row["etag"] as string,
    status: row["status"] as CalendarEvent["status"],
    summary: row["summary"] as string,
    description: row["description"] as string | undefined,
    location: row["location"] as string | undefined,
    start: fromJson<EventTime>(row["start_json"] as string | null, { timeZone: "UTC" }),
    end: fromJson<EventTime>(row["end_json"] as string | null, { timeZone: "UTC" }),
    allDay: !!(row["all_day"] as number),
    recurrence: fromJson<string[] | undefined>(row["recurrence"] as string | null, undefined),
    recurringEventId: row["recurring_event_id"] as string | undefined,
    originalStartTime: fromJson<EventTime | undefined>(
      row["original_start_time"] as string | null,
      undefined
    ),
    attendees: fromJson<Attendee[]>(row["attendees"] as string | null, []),
    organizer: fromJson<{ email: string; self: boolean } | undefined>(
      row["organizer"] as string | null,
      undefined
    ),
    created: row["created"] as string,
    updated: row["updated"] as string,
    source: "google",
    syncedAt: row["synced_at"] as string,
  };
}

// ── Free/busy + conflict detection ───────────────────────────────────────────

/**
 * Compute busy intervals from a list of confirmed timed events.
 * Events missing either dateTime are skipped — an `end: undefined` interval
 * would silently break free-slot computation and conflict detection.
 */
export function busyIntervals(events: CalendarEvent[]): FreeBusySlot[] {
  return events
    .filter(
      (e) => !e.allDay && e.status === "confirmed" && e.start.dateTime && e.end.dateTime
    )
    .map((e) => ({
      start: e.start.dateTime!,
      end: e.end.dateTime!,
      state: "busy" as const,
      source: e.id,
    }));
}

/** An instant carried as both epoch ms (for comparisons) and ISO (for output). */
interface Instant {
  ms: number;
  iso: string;
}

/**
 * Find free time slots in a window given busy intervals.
 *
 * All comparisons/sorting use epoch ms — lexicographic ISO-string comparison
 * misorders timestamps with different UTC offsets (e.g. "+05:30" vs "Z").
 * Free slots are clamped so they never extend past windowEnd or past the
 * work-hours end (workHoursEnd, UTC, on the window-end day).
 */
export function findFreeTime(
  windowStart: string,
  windowEnd: string,
  durationMin: number,
  events: CalendarEvent[],
  opts: { workHoursStart?: number; workHoursEnd?: number } = {}
): FreeBusySlot[] {
  const workStart = opts.workHoursStart ?? 9;
  const workEnd = opts.workHoursEnd ?? 18;

  const busy = busyIntervals(events)
    .map((b) => ({ ...b, startMs: Date.parse(b.start), endMs: Date.parse(b.end) }))
    .sort((a, b) => a.startMs - b.startMs);

  const free: FreeBusySlot[] = [];

  let cursor: Instant = clampToWorkHour(windowStart, workStart);

  // Effective end: windowEnd, additionally clamped to work-hours end (UTC).
  const windowEndMs = Date.parse(windowEnd);
  const workEndCap = new Date(windowEndMs);
  workEndCap.setUTCHours(workEnd, 0, 0, 0);
  const effectiveEnd: Instant =
    workEndCap.getTime() < windowEndMs
      ? { ms: workEndCap.getTime(), iso: workEndCap.toISOString() }
      : { ms: windowEndMs, iso: windowEnd };

  for (const b of busy) {
    if (b.startMs <= cursor.ms) {
      if (b.endMs > cursor.ms) cursor = { ms: b.endMs, iso: b.end };
      continue;
    }

    const slotEnd: Instant =
      b.startMs < effectiveEnd.ms ? { ms: b.startMs, iso: b.start } : effectiveEnd;

    if (slotEnd.ms - cursor.ms >= durationMin * 60_000) {
      free.push({ start: cursor.iso, end: slotEnd.iso, state: "free" });
    }
    if (b.endMs > cursor.ms) cursor = { ms: b.endMs, iso: b.end };
    if (cursor.ms >= effectiveEnd.ms) return free;
  }

  if (effectiveEnd.ms - cursor.ms >= durationMin * 60_000) {
    free.push({ start: cursor.iso, end: effectiveEnd.iso, state: "free" });
  }

  return free;
}

/** Detect conflicts: return busy slots that overlap the proposed time. */
export function detectConflicts(
  start: string,
  end: string,
  events: CalendarEvent[]
): FreeBusySlot[] {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return busyIntervals(events).filter(
    (b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs
  );
}

function clampToWorkHour(isoTs: string, hour: number): Instant {
  const d = new Date(isoTs);
  if (d.getUTCHours() < hour) {
    d.setUTCHours(hour, 0, 0, 0);
    return { ms: d.getTime(), iso: d.toISOString() };
  }
  return { ms: d.getTime(), iso: isoTs };
}

// ── Calendar write engine (feature 12 write path) ────────────────────────────

export interface CalendarWriteDeps {
  http: HttpClient;
  tokenStore: TokenStore;
  mirror: CalendarMirror;
}

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Execute a calendar write (create / update / delete) against the Google
 * Calendar API: validate → conflict-detect (mirror) → Google API → reconcile
 * the canonical response into the mirror. Google is the source of truth; the
 * mirror is only written from Google's response (no optimistic writes).
 *
 * Deterministic transport ONLY — no approval logic lives here. Callers must
 * arrive through the agent approval gate (feature 17): the ReAct loop blocks
 * every readOnly:false tool on ApprovalService before tool.run() executes.
 */
export async function executeEventWrite(
  req: EventWriteRequest,
  deps: CalendarWriteDeps,
): Promise<WriteResult> {
  const fail = (
    code: number,
    reason: string,
    retryable = false,
    conflicts?: FreeBusySlot[],
  ): WriteResult => ({
    requestId: req.requestId,
    ok: false,
    op: req.op,
    error: { code, reason, retryable },
    ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
  });

  // ── Validate (deterministic, no network) ──
  const start = req.patch?.start?.dateTime;
  const end = req.patch?.end?.dateTime;
  if (req.op === "create" && (!start || !end)) {
    return fail(400, "create requires patch.start.dateTime and patch.end.dateTime");
  }
  if ((req.op === "update" || req.op === "delete") && !req.eventId) {
    return fail(400, `${req.op} requires eventId`);
  }
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    return fail(400, "event end must be after start");
  }

  // ── Conflict detection against the local mirror ──
  // getEvents filters on event START within [from, to], so pad the window
  // backwards to catch events that started earlier but overlap the slot.
  let conflicts: FreeBusySlot[] = [];
  if ((req.op === "create" || req.op === "update") && start && end) {
    const padFrom = new Date(Date.parse(start) - 86_400_000).toISOString();
    const windowEvents = deps.mirror
      .getEvents(req.calendarId, padFrom, end)
      .filter((e) => e.id !== req.eventId); // moving an event never conflicts with itself
    conflicts = detectConflicts(start, end, windowEvents);
    if (conflicts.length > 0 && !req.allowConflict) {
      return fail(409, "proposed time conflicts with existing events", false, conflicts);
    }
  }

  // ── Auth (same path the read sync uses; handles refresh) ──
  let token: string;
  try {
    token = await getAccessToken("gcal", deps.tokenStore, deps.http, getRefreshConfig("gcal"));
  } catch (err) {
    return fail(401, err instanceof Error ? err.message : String(err));
  }

  // ── Execute against Google ──
  const eventsUrl = `${GCAL_BASE}/calendars/${encodeURIComponent(req.calendarId)}/events`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (req.ifMatchEtag && req.op !== "create") headers["If-Match"] = req.ifMatchEtag;

  let res: HttpResponse;
  if (req.op === "create") {
    res = await deps.http.request({
      method: "POST",
      url: eventsUrl,
      headers,
      body: patchToGoogleBody(req.patch),
    });
  } else if (req.op === "update") {
    res = await deps.http.request({
      method: "PATCH",
      url: `${eventsUrl}/${encodeURIComponent(req.eventId!)}`,
      headers,
      body: patchToGoogleBody(req.patch),
    });
  } else {
    res = await deps.http.request({
      method: "DELETE",
      url: `${eventsUrl}/${encodeURIComponent(req.eventId!)}`,
      headers,
    });
  }

  // ── Delete: 204/200 success; 410 = already gone, treat as success ──
  if (req.op === "delete") {
    if (res.status === 204 || res.status === 200 || res.status === 410) {
      deps.mirror.tombstoneEvent(req.calendarId, req.eventId!);
      return { requestId: req.requestId, ok: true, op: req.op };
    }
    return mapApiError(req, res, conflicts);
  }

  if (res.status !== 200 && res.status !== 201) {
    return mapApiError(req, res, conflicts);
  }

  // ── Reconcile the canonical event into the mirror ──
  const event = normalizeCalendarEvent(req.calendarId, res.body as RawGoogleEvent);
  deps.mirror.upsertEvent(event);
  return {
    requestId: req.requestId,
    ok: true,
    op: req.op,
    event,
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

function patchToGoogleBody(patch: EventWriteRequest["patch"]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (!patch) return body;
  if (patch.summary !== undefined) body["summary"] = patch.summary;
  if (patch.description !== undefined) body["description"] = patch.description;
  if (patch.location !== undefined) body["location"] = patch.location;
  if (patch.start !== undefined) body["start"] = patch.start;
  if (patch.end !== undefined) body["end"] = patch.end;
  if (patch.attendees !== undefined) body["attendees"] = patch.attendees;
  if (patch.recurrence !== undefined) body["recurrence"] = patch.recurrence;
  return body;
}

function mapApiError(
  req: EventWriteRequest,
  res: HttpResponse,
  conflicts: FreeBusySlot[],
): WriteResult {
  const retryable = res.status === 429 || res.status >= 500;
  const reason =
    res.status === 412
      ? "etag mismatch (event changed since last sync) — re-sync and retry with a fresh etag"
      : `Google Calendar API error: HTTP ${res.status}`;
  return {
    requestId: req.requestId,
    ok: false,
    op: req.op,
    error: { code: res.status, reason, retryable },
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

function resyncFloor(): string {
  return new Date(Date.now() - RESYNC_WINDOW_DAYS * 86_400_000).toISOString();
}

function resyncCeil(): string {
  return new Date(Date.now() + 365 * 86_400_000).toISOString();
}
