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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../src/db/schema.js";
import {
  CalendarMirror,
  executeEventWrite,
  type CalendarWriteDeps,
} from "../src/connectors/googleCalendar.js";
import { createIntegrations } from "../src/index.js";
import {
  FakeHttp,
  MemoryTokenStore,
  makeTokens,
  FixedClock,
  FakeLlm,
} from "../src/testing/fakes.js";
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

describe("executeEventWrite: validation", () => {
  it.each([
    ["create missing times", createReq({ patch: { summary: "No times" } })],
    [
      "create end before start",
      createReq({
        patch: {
          summary: "Backwards",
          start: { dateTime: "2026-06-12T16:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-06-12T15:00:00Z", timeZone: "UTC" },
        },
      }),
    ],
    ["update missing eventId", createReq({ op: "update", eventId: undefined })],
    [
      "delete missing eventId",
      { requestId: "r", op: "delete" as const, calendarId: "primary", reason: "t" },
    ],
  ])("%s → ok:false code 400 and no HTTP calls", async (_name, req) => {
    const { deps, http } = makeDeps();
    const result = await executeEventWrite(req as EventWriteRequest, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(400);
    expect(http.calls.length).toBe(0);
  });
});

describe("executeEventWrite: conflicts", () => {
  it("blocks a conflicting create with 409 + conflicts and no API call", async () => {
    const { deps, http, mirror } = makeDeps();
    mirror.upsertEvent(mirrorEvent()); // 15:00-16:00 existing

    const result = await executeEventWrite(createReq(), deps); // 15:00-15:30 overlaps

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(409);
    expect(result.conflicts?.length).toBe(1);
    expect(result.conflicts?.[0]?.source).toBe("evt-existing");
    expect(http.calls.length).toBe(0);
  });

  it("allowConflict:true proceeds with the write but still reports conflicts", async () => {
    const { deps, http, mirror } = makeDeps();
    mirror.upsertEvent(mirrorEvent());
    http.add(/\/calendars\/primary\/events$/, {
      status: 200,
      headers: {},
      body: googleEventResponse(),
    });

    const result = await executeEventWrite(createReq({ allowConflict: true }), deps);

    expect(result.ok).toBe(true);
    expect(result.conflicts?.length).toBe(1);
    expect(http.callCount(/\/calendars\/primary\/events$/)).toBe(1);
  });

  it("an update does not conflict with the event being moved", async () => {
    const { deps, http, mirror } = makeDeps();
    mirror.upsertEvent(mirrorEvent({ id: "evt-move-me" }));
    http.add(/\/events\/evt-move-me$/, {
      status: 200,
      headers: {},
      body: googleEventResponse({ id: "evt-move-me" }),
    });

    const result = await executeEventWrite(
      createReq({
        op: "update",
        eventId: "evt-move-me",
        patch: {
          start: { dateTime: "2026-06-12T15:30:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-06-12T16:30:00Z", timeZone: "UTC" },
        },
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    void http;
  });

  it("detects conflicts with events that started before the proposed slot", async () => {
    const { deps, http, mirror } = makeDeps();
    // 14:00-17:00 existing; proposed 15:00-15:30 sits inside it but starts later
    mirror.upsertEvent(
      mirrorEvent({
        start: { dateTime: "2026-06-12T14:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-06-12T17:00:00Z", timeZone: "UTC" },
      }),
    );

    const result = await executeEventWrite(createReq(), deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(409);
    expect(http.calls.length).toBe(0);
  });
});

describe("executeEventWrite: update", () => {
  it("PATCHes the event with If-Match and reconciles the response", async () => {
    const { deps, http, mirror } = makeDeps();
    http.add(/\/events\/evt-existing$/, {
      status: 200,
      headers: {},
      body: googleEventResponse({ id: "evt-existing", etag: '"etag-v2"', summary: "Moved" }),
    });

    const result = await executeEventWrite(
      createReq({
        op: "update",
        eventId: "evt-existing",
        ifMatchEtag: '"etag-existing"',
        patch: {
          start: { dateTime: "2026-06-12T15:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-06-12T15:30:00Z", timeZone: "UTC" },
        },
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    const patch = http.calls.find((c) => c.req.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.req.headers?.["If-Match"]).toBe('"etag-existing"');

    const mirrored = mirror.getEvents("primary", "2026-06-12T00:00:00Z", "2026-06-13T00:00:00Z");
    expect(mirrored.find((e) => e.id === "evt-existing")?.etag).toBe('"etag-v2"');
  });
});

describe("executeEventWrite: delete", () => {
  it("DELETEs the event and tombstones the mirror on 204", async () => {
    const { deps, http, mirror } = makeDeps();
    mirror.upsertEvent(mirrorEvent());
    http.add(/\/events\/evt-existing$/, { status: 204, headers: {}, body: {} });

    const result = await executeEventWrite(
      { requestId: "req-d", op: "delete", calendarId: "primary", eventId: "evt-existing", reason: "t" },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(http.calls.find((c) => c.req.method === "DELETE")).toBeDefined();
    const mirrored = mirror.getEvents("primary", "2026-06-12T00:00:00Z", "2026-06-13T00:00:00Z");
    expect(mirrored.find((e) => e.id === "evt-existing")).toBeUndefined();
  });

  it("treats 410 (already gone) as success", async () => {
    const { deps, http, mirror } = makeDeps();
    mirror.upsertEvent(mirrorEvent());
    http.add(/\/events\/evt-existing$/, { status: 410, headers: {}, body: {} });

    const result = await executeEventWrite(
      { requestId: "req-d2", op: "delete", calendarId: "primary", eventId: "evt-existing", reason: "t" },
      deps,
    );

    expect(result.ok).toBe(true);
  });
});

describe("executeEventWrite: error mapping", () => {
  it.each([
    [429, true],
    [500, true],
    [503, true],
    [403, false],
    [404, false],
  ])("HTTP %i → ok:false retryable=%s, mirror untouched", async (status, retryable) => {
    const { deps, http, mirror } = makeDeps();
    http.add(/\/calendars\/primary\/events$/, { status, headers: {}, body: {} });

    const result = await executeEventWrite(createReq(), deps);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(status);
    expect(result.error?.retryable).toBe(retryable);
    expect(mirror.getEvents("primary", "2026-06-12T00:00:00Z", "2026-06-13T00:00:00Z")).toEqual([]);
  });

  it("412 etag mismatch → not retryable, reason mentions etag", async () => {
    const { deps, http } = makeDeps();
    http.add(/\/events\/evt-existing$/, { status: 412, headers: {}, body: {} });

    const result = await executeEventWrite(
      createReq({
        op: "update",
        eventId: "evt-existing",
        ifMatchEtag: '"stale"',
        patch: { summary: "rename only" },
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(412);
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.reason).toContain("etag");
  });
});

describe("createIntegrations: bound calendar.executeWrite", () => {
  it("executes a write without the caller passing transport deps", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jarvis-calwrite-"));
    try {
      const http = new FakeHttp();
      const tokens = new MemoryTokenStore();
      tokens.seed("gcal", makeTokens());
      http.add(/\/calendars\/primary\/events$/, {
        status: 200,
        headers: {},
        body: googleEventResponse(),
      });

      const system = createIntegrations({
        http,
        clock: new FixedClock(),
        tokenStore: tokens,
        llm: new FakeLlm(),
        dataDir,
      });

      const result = await system.calendar.executeWrite(createReq());

      expect(result.ok).toBe(true);
      expect(result.event?.id).toBe("evt-new-1");
      // reconciled into the SAME mirror instance the system exposes
      const mirrored = system.calendar.mirror.getEvents(
        "primary",
        "2026-06-12T00:00:00Z",
        "2026-06-13T00:00:00Z",
      );
      expect(mirrored.map((e) => e.id)).toContain("evt-new-1");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
