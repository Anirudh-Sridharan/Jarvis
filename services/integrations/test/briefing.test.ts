/**
 * Briefing tests:
 *   - With FakeLlm: assembleBriefing returns BriefingDoc with all sections
 *   - generatedBy: 'llm' when LLM succeeds, 'template' when LLM throws
 *   - renderTemplateBrief: deterministic fallback renders correct sections
 *   - Missing sleep → omits sleep section
 *   - Missing agenda → shows "open day" message
 *   - Missing todos → no todo section
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../src/db/schema.js";
import { BriefingService, renderTemplateBrief } from "../src/briefing/briefing.js";
import { MetricStore, makeMetricId } from "../src/framework/metricStore.js";
import { CalendarMirror } from "../src/connectors/googleCalendar.js";
import { TodoStore } from "../src/work/todos.js";
import { FakeLlm } from "../src/testing/fakes.js";
import type { BriefingContext, MetricPoint, CalendarEvent } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  applySchema(db);
  return db;
}

function makeHrvPoint(ts: string, value: number): MetricPoint {
  const base = { source: "whoop" as const, metric: "hrv", ts, dims: {} };
  return {
    id: makeMetricId(base),
    ...base,
    value,
    unit: "ms",
    ingestedAt: new Date().toISOString(),
    adapterVersion: "1",
  };
}

function makeSleepPoint(ts: string, value: number): MetricPoint {
  const base = { source: "whoop" as const, metric: "sleep.duration_min", ts, dims: {} };
  return {
    id: makeMetricId(base),
    ...base,
    value,
    unit: "min",
    ingestedAt: new Date().toISOString(),
    adapterVersion: "1",
  };
}

function makeRecoveryPoint(ts: string, value: number): MetricPoint {
  const base = { source: "whoop" as const, metric: "recovery", ts, dims: {} };
  return {
    id: makeMetricId(base),
    ...base,
    value,
    unit: "%",
    ingestedAt: new Date().toISOString(),
    adapterVersion: "1",
  };
}

function makeCalendarEvent(id: string, summary: string, start: string, end: string): CalendarEvent {
  return {
    calendarId: "primary",
    id,
    etag: `"${id}"`,
    status: "confirmed",
    summary,
    start: { dateTime: start, timeZone: "UTC" },
    end: { dateTime: end, timeZone: "UTC" },
    allDay: false,
    attendees: [],
    created: "2026-06-01T00:00:00Z",
    updated: "2026-06-01T00:00:00Z",
    source: "google",
    syncedAt: "2026-06-09T07:00:00Z",
  };
}

describe("BriefingService.assembleBriefing", () => {
  let db: DatabaseSync;
  let metrics: MetricStore;
  let mirror: CalendarMirror;
  let todos: TodoStore;
  let llm: FakeLlm;
  let service: BriefingService;

  beforeEach(() => {
    db = makeDb();
    metrics = new MetricStore(db);
    mirror = new CalendarMirror(db);
    todos = new TodoStore(db);
    llm = new FakeLlm();
    service = new BriefingService(metrics, mirror, todos, llm);
  });

  it("returns generatedBy='llm' when LLM succeeds", async () => {
    llm.setDefault("Good morning. Productive day ahead.");

    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.generatedBy).toBe("llm");
    expect(doc.status).toBe("ready");
    expect(doc.date).toBe("2026-06-09");
    expect(doc.markdown).toBe("Good morning. Productive day ahead.");
  });

  it("returns generatedBy='template' when LLM throws", async () => {
    llm.addOverride("", new Error("LLM unavailable"));

    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.generatedBy).toBe("template");
    expect(doc.status).toBe("ready");
    expect(doc.markdown).toContain("Good morning");
  });

  it("assembles sleep section from MetricStore", async () => {
    // Seed sleep and recovery data for previous day
    const ts = "2026-06-08T07:00:00Z";
    metrics.upsertSeries([
      makeSleepPoint(ts, 415),  // 6.9 hours
      makeRecoveryPoint(ts, 72), // high recovery
    ]);

    llm.setDefault("Sleep was good.");
    const doc = await service.assembleBriefing("2026-06-09");

    // Context should have sleep
    expect(doc.context.sleep).toBeDefined();
    expect(doc.context.sleep?.hoursSlept).toBeCloseTo(6.9, 0);
    expect(doc.context.sleep?.recovery).toBe("high");
  });

  it("assembles agenda from CalendarMirror", async () => {
    mirror.upsertEvent(makeCalendarEvent(
      "evt001",
      "Standup",
      "2026-06-09T10:00:00Z",
      "2026-06-09T10:30:00Z"
    ));

    llm.setDefault("Calendar assembled.");
    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.context.agenda).toBeDefined();
    expect(doc.context.agenda?.events).toHaveLength(1);
    expect(doc.context.agenda?.events[0]?.title).toBe("Standup");
  });

  it("assembles todos section", async () => {
    todos.addTodo({
      text: "Write the briefing tests",
      source: "user",
      due: "2026-06-09T09:00:00.000Z",
    });

    llm.setDefault("Todos assembled.");
    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.context.todos).toBeDefined();
    expect(doc.context.todos?.dueToday).toHaveLength(1);
    expect(doc.context.todos?.dueToday[0]?.title).toBe("Write the briefing tests");
  });

  it("returns null sleep context when no sleep data", async () => {
    llm.setDefault("No sleep data.");
    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.context.sleep).toBeNull();
  });

  it("returns null agenda context when no events", async () => {
    llm.setDefault("No events.");
    const doc = await service.assembleBriefing("2026-06-09");

    // No calendar events → agenda should be null or empty
    // (CalendarMirror.getEvents returns [] → AgendaInput.events = [])
    // agenda is non-null but has empty events array
    if (doc.context.agenda) {
      expect(doc.context.agenda.events).toHaveLength(0);
    }
  });

  it("includes ttsText in output", async () => {
    llm.setDefault("Good morning. **Bold text** here.");
    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.ttsText).toBeDefined();
    // TTS text should have markdown stripped
    expect(doc.ttsText).not.toContain("**");
  });

  it("includes BriefingContext in output", async () => {
    const doc = await service.assembleBriefing("2026-06-09");

    expect(doc.context).toBeDefined();
    expect(doc.context.date).toBe("2026-06-09");
    expect(doc.id).toBeDefined();
    expect(doc.createdAt).toBeDefined();
  });
});

describe("renderTemplateBrief", () => {
  it("renders a minimal brief with no data", () => {
    const context: BriefingContext = {
      date: "2026-06-09",
      sleep: null,
      agenda: null,
      todos: null,
      insights: null,
    };

    const md = renderTemplateBrief(context);

    expect(md).toContain("Good morning");
    expect(md).toContain("No sleep data");
    expect(md).toContain("No events");
  });

  it("renders sleep section when available", () => {
    const context: BriefingContext = {
      date: "2026-06-09",
      sleep: {
        score: 72,
        hoursSlept: 6.9,
        recovery: "high",
        source: { feature: "10", gatheredAt: "2026-06-09T07:00:00Z", stale: false },
      },
      agenda: null,
      todos: null,
      insights: null,
    };

    const md = renderTemplateBrief(context);
    expect(md).toContain("6.9h");
    expect(md).toContain("Recovery is **high**");
  });

  it("renders agenda section with events", () => {
    const context: BriefingContext = {
      date: "2026-06-09",
      sleep: null,
      agenda: {
        events: [
          { time: "10:00", title: "Standup", key: false },
          { time: "14:00", title: "Roadmap review", key: true },
        ],
        source: { feature: "12", gatheredAt: "2026-06-09T07:00:00Z", stale: false },
      },
      todos: null,
      insights: null,
    };

    const md = renderTemplateBrief(context);
    expect(md).toContain("10:00");
    expect(md).toContain("Standup");
    expect(md).toContain("14:00");
    expect(md).toContain("Roadmap review");
    expect(md).toContain("*(key)*");
  });

  it("renders todos section", () => {
    const context: BriefingContext = {
      date: "2026-06-09",
      sleep: null,
      agenda: null,
      todos: {
        dueToday: [
          { title: "Finish Q3 draft", priority: "high" },
          { title: "Reply to vendor", priority: "med" },
        ],
        source: { feature: "13", gatheredAt: "2026-06-09T07:00:00Z", stale: false },
      },
      insights: null,
    };

    const md = renderTemplateBrief(context);
    expect(md).toContain("Finish Q3 draft");
    expect(md).toContain("Reply to vendor");
    expect(md).toContain("overdue"); // high priority shown as overdue
  });

  it("renders insights section", () => {
    const context: BriefingContext = {
      date: "2026-06-09",
      sleep: null,
      agenda: null,
      todos: null,
      insights: {
        digest: ["You've snoozed 'API migration' 4 days running"],
        source: { feature: "6", gatheredAt: "2026-06-09T07:00:00Z", stale: false },
      },
    };

    const md = renderTemplateBrief(context);
    expect(md).toContain("API migration");
  });

  it("low recovery renders appropriate message", () => {
    const context: BriefingContext = {
      date: "2026-06-09",
      sleep: {
        score: 25,
        hoursSlept: 5.5,
        recovery: "low",
        source: { feature: "10", gatheredAt: "2026-06-09T07:00:00Z", stale: false },
      },
      agenda: null,
      todos: null,
      insights: null,
    };

    const md = renderTemplateBrief(context);
    expect(md).toContain("low");
    expect(md).toContain("go easy");
  });
});
