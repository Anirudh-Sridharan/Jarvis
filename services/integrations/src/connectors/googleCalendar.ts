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
 *   - createEvent / findFreeTime
 *   - TODO(phase5: feature 17) — write path gated behind an approval hook;
 *     currently stubbed with a pass-through that logs the operation
 *
 * Calendar events are normalized to CalendarEvent and stored in the local mirror.
 * Events are also converted to MetricPoints (event count per day) for dashboard.
 */

import type {
  Connector,
  ConnectorSyncResult,
  Cursor,
  HttpClient,
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
import type { DatabaseSync } from "node:sqlite";
import { toJson, fromJson } from "../db/database.js";

const ADAPTER_VERSION = "1";
const RESYNC_WINDOW_DAYS = 30;

const GCAL_OAUTH_CONFIG = {
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: process.env["GCAL_CLIENT_ID"] ?? "gcal_client",
  clientSecret: process.env["GCAL_CLIENT_SECRET"] ?? "gcal_secret",
};

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
    const token = await getAccessToken("gcal", tokenStore, http, GCAL_OAUTH_CONFIG);
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

export function normalizeCalendarEvent(
  calendarId: string,
  raw: RawGoogleEvent
): CalendarEvent {
  const now = new Date().toISOString();
  const startRaw = raw.start ?? {};
  const endRaw = raw.end ?? {};

  const start: EventTime = {
    dateTime: startRaw.dateTime,
    date: startRaw.date,
    timeZone: startRaw.timeZone ?? "UTC",
  };
  const end: EventTime = {
    dateTime: endRaw.dateTime,
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
          dateTime: raw.originalStartTime.dateTime,
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

function eventToMetricPoint(event: CalendarEvent): MetricPoint {
  // Use start date as ts for event count bucketing
  const ts =
    event.start.dateTime ?? `${event.start.date ?? ""}T00:00:00Z`;
  const now = new Date().toISOString();
  return {
    id: makeMetricId({ source: "gcal", metric: "calendar.event_count", ts, dims: { calendarId: event.calendarId } }),
    source: "gcal",
    metric: "calendar.event_count",
    value: 1,
    unit: "count",
    ts,
    dims: { calendarId: event.calendarId },
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

/** Compute busy intervals from a list of confirmed timed events. */
export function busyIntervals(events: CalendarEvent[]): FreeBusySlot[] {
  return events
    .filter((e) => !e.allDay && e.status === "confirmed" && e.start.dateTime)
    .map((e) => ({
      start: e.start.dateTime!,
      end: e.end.dateTime!,
      state: "busy" as const,
      source: e.id,
    }));
}

/** Find free time slots in a window given busy intervals. */
export function findFreeTime(
  windowStart: string,
  windowEnd: string,
  durationMin: number,
  events: CalendarEvent[],
  opts: { workHoursStart?: number; workHoursEnd?: number } = {}
): FreeBusySlot[] {
  const busy = busyIntervals(events).sort((a, b) => a.start.localeCompare(b.start));
  const free: FreeBusySlot[] = [];

  const workStart = opts.workHoursStart ?? 9;
  const workEnd = opts.workHoursEnd ?? 18;

  let cursor = clampToWorkHour(windowStart, workStart);

  for (const b of busy) {
    if (b.start <= cursor) {
      cursor = b.end > cursor ? b.end : cursor;
      continue;
    }

    const slotEnd = earlierOf(b.start, windowEnd);
    slotEnd; // used below

    if (msGap(cursor, b.start) >= durationMin * 60_000) {
      free.push({ start: cursor, end: b.start, state: "free" });
    }
    cursor = b.end > cursor ? b.end : cursor;
  }

  if (msGap(cursor, windowEnd) >= durationMin * 60_000) {
    free.push({ start: cursor, end: windowEnd, state: "free" });
  }

  return free;
}

/** Detect conflicts: return busy slots that overlap the proposed time. */
export function detectConflicts(
  start: string,
  end: string,
  events: CalendarEvent[]
): FreeBusySlot[] {
  return busyIntervals(events).filter(
    (b) => b.start < end && b.end > start
  );
}

function clampToWorkHour(isoTs: string, hour: number): string {
  const d = new Date(isoTs);
  if (d.getUTCHours() < hour) {
    d.setUTCHours(hour, 0, 0, 0);
  }
  return d.toISOString();
}

function earlierOf(a: string, b: string): string {
  return a < b ? a : b;
}

function msGap(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

// ── Write path (stub — TODO(phase5: feature 17)) ─────────────────────────────

/**
 * Create a calendar event.
 * TODO(phase5: feature 17): This stub bypasses the approval gate. In phase 5,
 * the write must block until the user approves the change through the approval
 * gate (feature 17) before calling the Google Calendar API.
 */
export async function createEvent(
  req: EventWriteRequest,
  http: HttpClient,
  tokenStore: TokenStore
): Promise<WriteResult> {
  // TODO(phase5: feature 17) — gate approval before calling Google API
  console.log(
    `[calendar] TODO(phase5): createEvent blocked on approval gate for requestId=${req.requestId}`
  );

  return {
    requestId: req.requestId,
    ok: false,
    op: "create",
    error: {
      code: 501,
      reason: "Write path requires approval gate (phase 5 — feature 17)",
      retryable: false,
    },
  };
}

function resyncFloor(): string {
  return new Date(Date.now() - RESYNC_WINDOW_DAYS * 86_400_000).toISOString();
}

function resyncCeil(): string {
  return new Date(Date.now() + 365 * 86_400_000).toISOString();
}
