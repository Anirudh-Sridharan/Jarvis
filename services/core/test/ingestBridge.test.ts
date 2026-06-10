/**
 * Ingest bridge tests — integrations data → memory captureExternal:
 *   - calendar events converted with attendees/location, person entities
 *   - daily health + work digests from metric points
 *   - idempotency: second pass produces only duplicates (fake dedup by key)
 *   - empty stores → no captures
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntegrations, makeMetricId, type IntegrationsSystem } from "@jarvis/integrations";
import {
  FakeHttp,
  MemoryTokenStore,
  FixedClock,
  FakeLlm,
} from "@jarvis/integrations/testing";
import { runIngestPass, type IngestDeps } from "../src/memory/ingestBridge.js";

const NOW = new Date("2026-06-10T12:00:00Z");

type CapturedOpts = {
  source: string;
  type: string;
  nativeId: string;
  text: string;
  content?: unknown;
  entities?: Array<{ kind: string; value: string }>;
};

function makeFakeMemory() {
  const seen = new Set<string>();
  const captured: CapturedOpts[] = [];
  const memory = {
    capture: {
      captureExternal: async (opts: CapturedOpts) => {
        const key = `${opts.source}:${opts.nativeId}:${JSON.stringify(opts.content ?? opts.text)}`;
        const inserted = !seen.has(key);
        seen.add(key);
        if (inserted) captured.push(opts);
        return { inserted, record: {} };
      },
    },
  };
  return { memory: memory as unknown as IngestDeps["memory"], captured };
}

let dataDir: string;
let integrations: IntegrationsSystem;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "jarvis-ingest-bridge-"));
  const tokens = new MemoryTokenStore();
  integrations = createIntegrations({
    http: new FakeHttp(),
    clock: new FixedClock(NOW.getTime()),
    tokenStore: tokens,
    llm: new FakeLlm(),
    dataDir,
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seedCalendarEvent(): void {
  integrations.calendar.mirror.upsertEvent({
    calendarId: "primary",
    id: "evt-standup",
    etag: '"v1"',
    status: "confirmed",
    summary: "Standup",
    location: "Zoom",
    start: { dateTime: "2026-06-11T10:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-11T10:30:00Z", timeZone: "UTC" },
    allDay: false,
    attendees: [
      { email: "me@example.com", response: "accepted", self: true, organizer: false },
      { email: "pat@example.com", displayName: "Pat", response: "accepted", self: false, organizer: true },
    ],
    created: "2026-06-01T09:00:00Z",
    updated: "2026-06-01T09:00:00Z",
    source: "google",
    syncedAt: "2026-06-10T08:00:00Z",
  });
}

function seedMetrics(): void {
  const mk = (metric: string, source: string, value: number, ts: string) => ({
    id: makeMetricId({ source, metric, ts, dims: {} }),
    source: source as never,
    metric,
    value,
    unit: "count",
    ts,
    dims: {},
    ingestedAt: NOW.toISOString(),
    adapterVersion: "1",
  });
  integrations.metrics.upsertSeries([
    mk("sleep.duration_min", "whoop", 465, "2026-06-10T07:00:00Z"),
    mk("recovery", "whoop", 72, "2026-06-10T07:00:00Z"),
    mk("hrv", "whoop", 45, "2026-06-10T07:00:00Z"),
    mk("github.commits", "github", 7, "2026-06-10T09:00:00Z"),
    mk("gmail.received", "gmail", 21, "2026-06-10T00:00:00Z"),
    mk("gmail.sent", "gmail", 4, "2026-06-10T00:00:00Z"),
  ]);
}

describe("runIngestPass", () => {
  it("captures calendar events with attendees and person entities", async () => {
    seedCalendarEvent();
    const { memory, captured } = makeFakeMemory();

    const result = await runIngestPass({ memory, integrations, now: () => NOW });

    expect(result.captured).toBe(1);
    const cal = captured.find((c) => c.type === "calendar_event")!;
    expect(cal.source).toBe("gcal");
    expect(cal.nativeId).toBe("evt-standup");
    expect(cal.text).toContain("Standup");
    expect(cal.text).toContain("at Zoom");
    expect(cal.text).toContain("with Pat");
    expect(cal.entities).toEqual([{ kind: "person", value: "Pat" }]);
  });

  it("captures daily health and work digests from metric points", async () => {
    seedMetrics();
    const { memory, captured } = makeFakeMemory();

    const result = await runIngestPass({ memory, integrations, now: () => NOW });

    expect(result.captured).toBe(2);
    const health = captured.find((c) => c.type === "health_metric")!;
    expect(health.text).toBe("Health 2026-06-10: slept 7.8h; recovery 72%; HRV 45ms");
    const work = captured.find((c) => c.type === "code_activity")!;
    expect(work.text).toBe("Work activity 2026-06-10: 7 commits; 21 emails received, 4 sent");
  });

  it("is idempotent — second pass yields only duplicates", async () => {
    seedCalendarEvent();
    seedMetrics();
    const { memory } = makeFakeMemory();

    const first = await runIngestPass({ memory, integrations, now: () => NOW });
    const second = await runIngestPass({ memory, integrations, now: () => NOW });

    expect(first.captured).toBe(3);
    expect(second.captured).toBe(0);
    expect(second.duplicates).toBe(3);
  });

  it("re-captures a calendar event when its etag/times change", async () => {
    seedCalendarEvent();
    const { memory } = makeFakeMemory();
    await runIngestPass({ memory, integrations, now: () => NOW });

    // Move the event
    integrations.calendar.mirror.upsertEvent({
      calendarId: "primary",
      id: "evt-standup",
      etag: '"v2"',
      status: "confirmed",
      summary: "Standup",
      start: { dateTime: "2026-06-11T11:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-11T11:30:00Z", timeZone: "UTC" },
      allDay: false,
      attendees: [],
      created: "2026-06-01T09:00:00Z",
      updated: "2026-06-10T10:00:00Z",
      source: "google",
      syncedAt: "2026-06-10T10:00:00Z",
    });

    const result = await runIngestPass({ memory, integrations, now: () => NOW });
    expect(result.captured).toBe(1);
  });

  it("captures nothing from empty stores", async () => {
    const { memory } = makeFakeMemory();
    const result = await runIngestPass({ memory, integrations, now: () => NOW });
    expect(result.captured).toBe(0);
    expect(result.duplicates).toBe(0);
  });
});
