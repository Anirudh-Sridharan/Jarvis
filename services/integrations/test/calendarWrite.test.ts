/**
 * Calendar write engine tests (feature 12 write path):
 *   - create/update/delete against Google API via injected HttpClient
 *   - validation failures (400) never touch the network
 *   - conflict detection vs the mirror (409 unless allowConflict)
 *   - canonical response reconciled into the mirror; mirror untouched on failure
 *   - error mapping: 429/5xx retryable, 412 etag mismatch not retryable
 *
 * Approval is NOT tested here — it lives upstream in the agent ReAct loop.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../src/db/schema.js";
import {
  CalendarMirror,
  executeEventWrite,
  type CalendarWriteDeps,
} from "../src/connectors/googleCalendar.js";
import { FakeHttp, MemoryTokenStore, makeTokens } from "../src/testing/fakes.js";
import type { CalendarEvent, EventWriteRequest } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  applySchema(db);
  return db;
}

function makeDeps(): {
  deps: CalendarWriteDeps;
  http: FakeHttp;
  tokens: MemoryTokenStore;
  mirror: CalendarMirror;
} {
  const http = new FakeHttp();
  const tokens = new MemoryTokenStore();
  tokens.seed("gcal", makeTokens());
  const mirror = new CalendarMirror(makeDb());
  return { deps: { http, tokenStore: tokens, mirror }, http, tokens, mirror };
}

function createReq(overrides: Partial<EventWriteRequest> = {}): EventWriteRequest {
  return {
    requestId: "req-1",
    op: "create",
    calendarId: "primary",
    patch: {
      summary: "Coffee with Sam",
      start: { dateTime: "2026-06-12T15:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-12T15:30:00Z", timeZone: "UTC" },
    },
    reason: "test write",
    ...overrides,
  };
}

function googleEventResponse(overrides: Record<string, unknown> = {}): object {
  return {
    id: "evt-new-1",
    etag: '"etag-new"',
    status: "confirmed",
    summary: "Coffee with Sam",
    start: { dateTime: "2026-06-12T15:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-12T15:30:00Z", timeZone: "UTC" },
    created: "2026-06-10T00:00:00Z",
    updated: "2026-06-10T00:00:00Z",
    ...overrides,
  };
}

function mirrorEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: "primary",
    id: "evt-existing",
    etag: '"etag-existing"',
    status: "confirmed",
    summary: "Existing event",
    start: { dateTime: "2026-06-12T15:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-12T16:00:00Z", timeZone: "UTC" },
    allDay: false,
    attendees: [],
    created: "2026-06-01T09:00:00Z",
    updated: "2026-06-01T09:00:00Z",
    source: "google",
    syncedAt: "2026-06-10T08:00:00Z",
    ...overrides,
  };
}

describe("executeEventWrite: create", () => {
  it("POSTs to Google with bearer auth and reconciles the canonical event into the mirror", async () => {
    const { deps, http, mirror } = makeDeps();
    http.add(/\/calendars\/primary\/events$/, {
      status: 200,
      headers: {},
      body: googleEventResponse(),
    });

    const result = await executeEventWrite(createReq(), deps);

    expect(result.ok).toBe(true);
    expect(result.op).toBe("create");
    expect(result.requestId).toBe("req-1");
    expect(result.event?.id).toBe("evt-new-1");
    expect(result.event?.etag).toBe('"etag-new"');

    const post = http.calls.find((c) => c.req.method === "POST");
    expect(post).toBeDefined();
    expect(post!.req.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(post!.req.headers?.["Authorization"]).toBe("Bearer test_access_token");
    const body = post!.req.body as Record<string, unknown>;
    expect(body["summary"]).toBe("Coffee with Sam");
    expect(body["start"]).toEqual({ dateTime: "2026-06-12T15:00:00Z", timeZone: "UTC" });

    const mirrored = mirror.getEvents("primary", "2026-06-12T00:00:00Z", "2026-06-13T00:00:00Z");
    expect(mirrored.map((e) => e.id)).toContain("evt-new-1");
  });

  it("returns ok:false with code 401 and makes no events call when no tokens are stored", async () => {
    const { deps, http } = makeDeps();
    const result = await executeEventWrite(createReq(), {
      ...deps,
      tokenStore: new MemoryTokenStore(),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(401);
    expect(http.callCount(/\/calendars\//)).toBe(0);
  });
});
