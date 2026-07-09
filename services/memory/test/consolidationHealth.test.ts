/**
 * Tests for MemoryStore.getConsolidationHealth() (MEM-03): the read-only
 * observability aggregate consumed by core's GET /telemetry and the
 * dashboard's /api/memory/health BFF route.
 *
 * Reuses makeConsolidation()/AlwaysFailingLlm verbatim from consolidation.test.ts
 * (services/memory/test/consolidation.test.ts) — see 12-RESEARCH.md Pitfall 4:
 * forced-failure visibility is proven hermetically, never against a live LLM.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { ConsolidationService } from "../src/consolidation/consolidation.js";
import { FakeEmbedder, FakeLlm, FixedClock } from "../src/testing/fakes.js";
import { CaptureService } from "../src/capture/capture.js";
import { DEAD_LETTER_THRESHOLD } from "../src/consolidation/retryPolicy.js";
import type { Clock } from "../src/types.js";

function makeConsolidation(fakeLlm?: FakeLlm, clock?: Clock) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-consol-health-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const llm = fakeLlm ?? new FakeLlm();
  const capture = new CaptureService(store, embedder);
  const consolidation = new ConsolidationService(store, llm, embedder, clock);
  return { store, consolidation, capture, llm };
}

/** LLM that ALWAYS fails extraction for records containing a "FAILME" marker
 *  (verbatim from consolidation.test.ts's MEM-02 dead-letter suite). */
class AlwaysFailingLlm extends FakeLlm {
  override async complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
  }): Promise<string> {
    if (
      opts.prompt.includes("discrete, updateable FACTS") &&
      opts.prompt.includes("FAILME")
    ) {
      throw new Error("simulated permanent LLM extraction failure");
    }
    return super.complete(opts);
  }
}

describe("MemoryStore.getConsolidationHealth() - empty DB", () => {
  it("returns all-zero counts and lastRun null, never throws", () => {
    const { store } = makeConsolidation();
    const health = store.getConsolidationHealth();
    expect(health).toEqual({
      pendingCount: 0,
      consolidatedCount: 0,
      deadLetterCount: 0,
      lastRun: null,
    });
  });
});

describe("MemoryStore.getConsolidationHealth() - seeded mix", () => {
  it("returns exact pending/consolidated/dead-letter counts for a seeded mix", async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { store, capture, consolidation } = makeConsolidation(llm, clock);

    // 1 record that consolidates cleanly.
    await capture.captureNote({
      text: "I prefer TypeScript over Python for type safety",
      noteId: "mix-consolidated-1",
    });
    await consolidation.run("manual");

    // 1 record dead-lettered across DEAD_LETTER_THRESHOLD failed passes.
    await capture.captureNote({ text: "FAILME dead letter seed", noteId: "mix-dead-1" });
    for (let i = 0; i < DEAD_LETTER_THRESHOLD; i++) {
      await consolidation.run("manual");
      clock.advance(7 * 60 * 60_000); // past the 6h max backoff cap
    }

    // 2 records captured AFTER the last consolidation pass — stay pending.
    await capture.captureNote({ text: "I like coffee", noteId: "mix-pending-1" });
    await capture.captureNote({ text: "I like tea", noteId: "mix-pending-2" });

    const health = store.getConsolidationHealth();
    expect(health.pendingCount).toBe(2);
    expect(health.consolidatedCount).toBe(1);
    expect(health.deadLetterCount).toBe(1);
    expect(health.lastRun).not.toBeNull();
    expect(Array.isArray(health.lastRun!.errors)).toBe(true);
    expect(typeof health.lastRun!.counts).toBe("object");
  });
});

describe("MemoryStore.getConsolidationHealth() - SC3 forced-failure visibility", () => {
  it(`a record dead-lettered after ${String(DEAD_LETTER_THRESHOLD)} failed passes is visible via deadLetterCount and lastRun.errors`, async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { store, capture, consolidation } = makeConsolidation(llm, clock);
    const { record } = await capture.captureNote({ text: "FAILME dead letter", noteId: "sc3-dead" });

    for (let i = 0; i < DEAD_LETTER_THRESHOLD; i++) {
      await consolidation.run("manual");
      clock.advance(7 * 60 * 60_000);
    }

    // Sanity: the existing MEM-02 dead-letter mechanism itself fired.
    const dead = store.getDeadLetterRecords();
    expect(dead.find((r) => r.id === record.id)).toBeDefined();

    // The NEW observability query reflects that already-proven mechanism.
    const health = store.getConsolidationHealth();
    expect(health.deadLetterCount).toBeGreaterThan(0);
    expect(health.lastRun).not.toBeNull();
    expect(health.lastRun!.errors.length).toBeGreaterThan(0);
  });
});

describe("MemoryStore.getConsolidationHealth() - Pitfall-1 regression guard", () => {
  it("a 'partial' run with non-empty errors is distinguishable from a clean pass — errors, not status, is the load-bearing signal", async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { store, capture, consolidation } = makeConsolidation(llm, clock);
    await capture.captureNote({ text: "FAILME single attempt", noteId: "pitfall1" });

    const result = await consolidation.run("manual");
    // The pipeline never persists status "failed" (see RESEARCH.md Pitfall 1) —
    // a stage failure surfaces as "partial", not "failed".
    expect(result.run.status).toBe("partial");

    const health = store.getConsolidationHealth();
    expect(health.lastRun).not.toBeNull();
    expect(health.lastRun!.status).toBe("partial");
    expect(health.lastRun!.status).not.toBe("failed");
    // The real "something needs attention" signal is errors.length > 0, which
    // survives even though status alone reads as merely "partial" (ambiguous,
    // not obviously alarming) rather than an unambiguous failure marker.
    expect(health.lastRun!.errors.length).toBeGreaterThan(0);
  });
});

describe("MemoryStore.getConsolidationHealth() - T-12-01 content-safety truncation", () => {
  it("truncates a surfaced error message longer than MAX_SURFACED_ERROR_CHARS", () => {
    const { store } = makeConsolidation();
    const longMessage = "x".repeat(250);

    store.insertConsolidationRun({
      id: "run-trunc-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "partial",
      stage: 9,
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      inputRecordIds: [],
      counts: {
        recordsProcessed: 0,
        factsExtracted: 0,
        factsMerged: 0,
        factsInvalidated: 0,
        factsForgotten: 0,
        factsCompressed: 0,
        insightsGenerated: 0,
        embeddingsWritten: 0,
        conflictsFlagged: 0,
      },
      errors: [{ stage: 3, message: longMessage }],
      trigger: "manual",
    });

    const health = store.getConsolidationHealth();
    expect(health.lastRun).not.toBeNull();
    const surfaced = health.lastRun!.errors[0]!.message;
    expect(surfaced.length).toBeLessThan(longMessage.length);
    expect(surfaced.startsWith("x".repeat(200))).toBe(true);
    expect(surfaced.endsWith("…[truncated]")).toBe(true);
  });
});
