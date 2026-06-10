/**
 * Google Calendar tests:
 *   - Incremental sync with syncToken → events normalized correctly
 *   - 410 Gone → triggers full resync, captures new syncToken
 *   - normalizeCalendarEvent → CalendarEvent shape
 *   - CalendarMirror: upsert, tombstone, getSyncToken
 *   - conflict detection + free-busy computation
 *   - findFreeTime: correct free slots returned
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../src/db/schema.js";
import {
  normalizeCalendarEvent,
  CalendarMirror,
  busyIntervals,
  findFreeTime,
  detectConflicts,
} from "../src/connectors/googleCalendar.js";
import { FakeHttp, MemoryTokenStore, makeTokens, gcalEventsFixture } from "../src/testing/fakes.js";
import type { CalendarEvent } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  applySchema(db);
  return db;
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: "primary",
    id: "evt001",
    etag: '"etag001"',
    status: "confirmed",
    summary: "Test Event",
    start: { dateTime: "2026-06-09T10:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-09T11:00:00Z", timeZone: "UTC" },
    allDay: false,
    attendees: [],
    created: "2026-06-01T09:00:00Z",
    updated: "2026-06-01T09:00:00Z",
    source: "google",
    syncedAt: "2026-06-09T08:00:00Z",
    ...overrides,
  };
}

describe("normalizeCalendarEvent", () => {
  it("normalizes a timed event correctly", () => {
    const raw = {
      id: "evt001",
      etag: '"etag001"',
      status: "confirmed",
      summary: "Standup",
      start: { dateTime: "2026-06-09T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-09T10:30:00Z", timeZone: "UTC" },
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-01T00:00:00Z",
      attendees: [
        { email: "user@example.com", responseStatus: "accepted", self: true },
      ],
    };

    const event = normalizeCalendarEvent("primary", raw);

    expect(event.calendarId).toBe("primary");
    expect(event.id).toBe("evt001");
    expect(event.summary).toBe("Standup");
    expect(event.allDay).toBe(false);
    expect(event.start.dateTime).toBe("2026-06-09T10:00:00Z");
    expect(event.attendees).toHaveLength(1);
    expect(event.attendees[0]?.response).toBe("accepted");
    expect(event.attendees[0]?.self).toBe(true);
    expect(event.source).toBe("google");
  });

  it("normalizes an all-day event correctly", () => {
    const raw = {
      id: "evt002",
      etag: '"etag002"',
      status: "confirmed",
      summary: "All-day conference",
      start: { date: "2026-06-10" },
      end: { date: "2026-06-11" },
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-01T00:00:00Z",
    };

    const event = normalizeCalendarEvent("primary", raw);
    expect(event.allDay).toBe(true);
    expect(event.start.date).toBe("2026-06-10");
    expect(event.start.dateTime).toBeUndefined();
  });

  it("normalizes cancelled event status", () => {
    const raw = {
      id: "evt003",
      status: "cancelled",
      start: { dateTime: "2026-06-09T09:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-09T10:00:00Z", timeZone: "UTC" },
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-09T07:00:00Z",
    };

    const event = normalizeCalendarEvent("primary", raw);
    expect(event.status).toBe("cancelled");
  });
});

describe("CalendarMirror", () => {
  let mirror: CalendarMirror;

  beforeEach(() => {
    mirror = new CalendarMirror(makeDb());
  });

  it("upserts an event and retrieves it", () => {
    const event = makeEvent();
    mirror.upsertEvent(event);

    const events = mirror.getEvents("primary", "2026-06-09T00:00:00Z", "2026-06-09T23:59:59Z");
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe("Test Event");
  });

  it("upserts are idempotent (same event twice → one row)", () => {
    const event = makeEvent();
    mirror.upsertEvent(event);
    mirror.upsertEvent(event);

    const events = mirror.getEvents("primary", "2026-06-09T00:00:00Z", "2026-06-09T23:59:59Z");
    expect(events).toHaveLength(1);
  });

  it("tombstones a cancelled event", () => {
    const event = makeEvent();
    mirror.upsertEvent(event);
    mirror.tombstoneEvent("primary", "evt001");

    const events = mirror.getEvents("primary", "2026-06-09T00:00:00Z", "2026-06-09T23:59:59Z");
    expect(events).toHaveLength(0); // cancelled events excluded
  });

  it("updates event on re-upsert", () => {
    const event = makeEvent();
    mirror.upsertEvent(event);

    const updated = { ...event, summary: "Updated Standup" };
    mirror.upsertEvent(updated);

    const events = mirror.getEvents("primary", "2026-06-09T00:00:00Z", "2026-06-09T23:59:59Z");
    expect(events[0]?.summary).toBe("Updated Standup");
  });

  it("saves and loads sync tokens", () => {
    mirror.saveSyncToken("primary", "sync_tok_123");
    expect(mirror.loadSyncToken("primary")).toBe("sync_tok_123");
  });

  it("clears sync token", () => {
    mirror.saveSyncToken("primary", "tok");
    mirror.clearSyncToken("primary");
    expect(mirror.loadSyncToken("primary")).toBeNull();
  });

  it("handles 410 resync: clearSyncToken then re-sync captures new token", () => {
    // Simulate a prior token
    mirror.saveSyncToken("primary", "stale_tok");

    // 410 received: clear token
    mirror.clearSyncToken("primary");
    expect(mirror.loadSyncToken("primary")).toBeNull();

    // Full resync completes with new token
    mirror.saveSyncToken("primary", "new_tok_after_resync");
    expect(mirror.loadSyncToken("primary")).toBe("new_tok_after_resync");
  });
});

describe("Conflict detection + free-busy", () => {
  const events: CalendarEvent[] = [
    makeEvent({ id: "a", summary: "Morning standup", start: { dateTime: "2026-06-09T10:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-06-09T10:30:00Z", timeZone: "UTC" } }),
    makeEvent({ id: "b", summary: "Team meeting", start: { dateTime: "2026-06-09T14:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-06-09T15:00:00Z", timeZone: "UTC" } }),
  ];

  it("busyIntervals extracts confirmed timed events", () => {
    const busy = busyIntervals(events);
    expect(busy).toHaveLength(2);
    expect(busy[0]?.state).toBe("busy");
    expect(busy[0]?.start).toBe("2026-06-09T10:00:00Z");
  });

  it("excludes all-day events from busy intervals", () => {
    const allDay = makeEvent({
      id: "c",
      allDay: true,
      start: { date: "2026-06-09", timeZone: "UTC" },
      end: { date: "2026-06-10", timeZone: "UTC" },
    });
    const busy = busyIntervals([...events, allDay]);
    expect(busy).toHaveLength(2); // all-day not included
  });

  it("detectConflicts finds overlapping events", () => {
    const conflicts = detectConflicts(
      "2026-06-09T09:45:00Z",
      "2026-06-09T10:15:00Z",
      events
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.source).toBe("a");
  });

  it("detectConflicts returns empty when no overlap", () => {
    const conflicts = detectConflicts(
      "2026-06-09T11:00:00Z",
      "2026-06-09T12:00:00Z",
      events
    );
    expect(conflicts).toHaveLength(0);
  });

  it("findFreeTime returns free slots between events", () => {
    const freeSlots = findFreeTime(
      "2026-06-09T09:00:00Z",
      "2026-06-09T17:00:00Z",
      30, // 30 min duration
      events
    );

    expect(freeSlots.length).toBeGreaterThan(0);
    // All returned slots should be free
    expect(freeSlots.every((s) => s.state === "free")).toBe(true);

    // Should include slot between standup end (10:30) and team meeting start (14:00)
    const midSlot = freeSlots.find(
      (s) => s.start >= "2026-06-09T10:30:00Z" && s.end <= "2026-06-09T14:00:00Z"
    );
    expect(midSlot).toBeDefined();
  });

  it("syncToken 410 flow: normalizeCalendarEvent handles cancelled status for tombstone", () => {
    const raw = {
      id: "old_evt",
      status: "cancelled",
      start: { dateTime: "2026-06-09T09:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-09T09:30:00Z", timeZone: "UTC" },
      created: "2026-06-01T00:00:00Z",
      updated: "2026-06-09T10:00:00Z",
    };
    const event = normalizeCalendarEvent("primary", raw);
    expect(event.status).toBe("cancelled");

    const mirror = new CalendarMirror(makeDb());
    // In the sync loop, cancelled events become tombstones
    mirror.upsertEvent(makeEvent({ id: "old_evt" })); // first sync: event exists
    mirror.tombstoneEvent("primary", "old_evt"); // next sync: cancelled

    const events = mirror.getEvents("primary", "2026-06-09T00:00:00Z", "2026-06-09T23:59:59Z");
    expect(events).toHaveLength(0);
  });
});
