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
import { createMemorySystem } from "@jarvis/memory";
// Aliased to avoid colliding with @jarvis/integrations/testing's FakeLlm above —
// this pair backs the real MemorySystem the MEM-06 case constructs below.
import { FakeEmbedder as MemoryFakeEmbedder, FakeLlm as MemoryFakeLlm } from "@jarvis/memory/testing";
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

// makeFakeMemory() above exposes only capture.captureExternal — no store,
// consolidation, or retrieval — so it is structurally incapable of proving
// MEM-06 (recall by content after force-consolidation). This helper builds a
// real createMemorySystem instead, mirroring files-ingest.test.ts's
// makeMemory(). IngestDeps.memory is typed Pick<MemorySystem, "capture">, so
// a full MemorySystem satisfies it structurally with no cast.
const mem06DataDirs: string[] = [];
function makeRealMemory(llm: MemoryFakeLlm) {
  const memDataDir = mkdtempSync(join(tmpdir(), "jarvis-ingest-bridge-mem-"));
  mem06DataDirs.push(memDataDir);
  return createMemorySystem({ embedder: new MemoryFakeEmbedder(), llm, dataDir: memDataDir });
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
  for (const d of mem06DataDirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
    mk("sleep.duration_min", "whoop", 465, "2026-06-09T07:00:00Z"),
    mk("recovery", "whoop", 72, "2026-06-09T07:00:00Z"),
    mk("hrv", "whoop", 45, "2026-06-09T07:00:00Z"),
    mk("github.commits", "github", 7, "2026-06-09T09:00:00Z"),
    mk("gmail.received", "gmail", 21, "2026-06-09T00:00:00Z"),
    mk("gmail.sent", "gmail", 4, "2026-06-09T00:00:00Z"),
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
    expect(health.text).toBe("Health 2026-06-09: slept 7.8h; recovery 72%; HRV 45ms");
    const work = captured.find((c) => c.type === "code_activity")!;
    expect(work.text).toBe("Work activity 2026-06-09: 7 commits; 21 emails received, 4 sent");
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

describe("runIngestPass: digest churn guard", () => {
  it("intra-day value drift does NOT spawn duplicate digests (day-keyed dedup)", async () => {
    seedMetrics();
    const { memory } = makeFakeMemory();
    const first = await runIngestPass({ memory, integrations, now: () => NOW });
    expect(first.captured).toBe(2);

    // More commits land for yesterday (late sync) — values change
    integrations.metrics.upsertSeries([
      {
        id: makeMetricId({ source: "github", metric: "github.commits", ts: "2026-06-09T15:00:00Z", dims: {} }),
        source: "github" as never,
        metric: "github.commits",
        value: 5,
        unit: "count",
        ts: "2026-06-09T15:00:00Z",
        dims: {},
        ingestedAt: NOW.toISOString(),
        adapterVersion: "1",
      },
    ]);

    const second = await runIngestPass({ memory, integrations, now: () => NOW });
    expect(second.captured).toBe(0); // day-keyed content: no contradictory re-capture
    expect(second.duplicates).toBe(2);
  });
});

// SC3 coverage boundary this file completes: local documents (files-ingest.test.ts),
// the Obsidian vault (vault-ingest.test.ts), and Gmail bodies (email-ingest.test.ts)
// each prove MEM-06 recall. This describe block adds the fourth and final core
// surface — the connector ingest bridge (calendar events + health/work digests).
// iMessage is explicitly NOT covered here: Phase 9 shipped only the hermetic
// orchestrator/safety logic, so there is no real chat.db capture surface to
// force-consolidate yet. That live wiring is deferred to Phase 10.
describe("runIngestPass - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  it("promotes a converted calendar event into the retrievable graph after consolidation, against a real MemorySystem", async () => {
    const marker = "eval-canary-bridge-evt1";

    integrations.calendar.mirror.upsertEvent({
      calendarId: "primary",
      id: "evt-canary",
      etag: '"v1"',
      status: "confirmed",
      summary: marker,
      start: { dateTime: "2026-06-11T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-06-11T10:30:00Z", timeZone: "UTC" },
      allDay: false,
      attendees: [],
      created: "2026-06-01T09:00:00Z",
      updated: "2026-06-01T09:00:00Z",
      source: "google",
      syncedAt: "2026-06-10T08:00:00Z",
    });

    // makeFakeMemory() exposes only capture.captureExternal — no store, no
    // consolidation, no retrieval — so it is structurally incapable of proving
    // MEM-06. This case builds a real createMemorySystem via makeRealMemory()
    // instead. IngestDeps.memory is typed Pick<MemorySystem, "capture">, so the
    // full MemorySystem satisfies it structurally with no cast.
    const llm = new MemoryFakeLlm();
    // MemoryFakeLlm's default extraction is a fixed "User prefers TypeScript"
    // result, and consolidation never copies a record's literal text into the
    // graph — so without this override the marker cannot possibly come back,
    // and the test would be measuring the fake, not the pipeline.
    // reflectInsights()'s prompt also embeds a raw sample of the same pending
    // record text (under "Recent experiences:"), so the marker override would
    // otherwise ALSO match the reflection call and mint a duplicate
    // marker-bearing EPISODE via indexInsightAsEpisode(). Suppress reflection
    // explicitly — FakeLlm checks overrides in insertion order, so this must
    // be registered FIRST to win for the reflect prompt; the extraction
    // prompt never contains "Recent experiences:", so the marker override
    // below still matches it (WR-03, mirroring the memory-side retrofits).
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        { entity: "self", predicate: "mentions", object: "canary", text: `Canary note: ${marker}`, confidence: 0.9 },
      ]),
    );
    const realMemory = makeRealMemory(llm);

    const result = await runIngestPass({ memory: realMemory, integrations, now: () => NOW });
    expect(result.captured).toBeGreaterThanOrEqual(1);

    const consolidationResult = await realMemory.consolidation.run("manual");
    expect(consolidationResult.run.status).toBe("completed");
    expect(consolidationResult.run.errors.length).toBe(0);
    expect(consolidationResult.run.counts.recordsProcessed).toBeGreaterThanOrEqual(1);

    // kind === "fact" pins the marker to the extract→resolve→fact promotion
    // path specifically — a reflection-minted episode (or a still-pending
    // record) satisfying a bare text-includes check would prove only that the
    // marker reached the graph via SOME path (WR-03).
    const hits = await realMemory.retrieval.retrieve(marker, { k: 5 });
    const hit = hits.find((h) => h.text.includes(marker));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("fact");
  });
});
