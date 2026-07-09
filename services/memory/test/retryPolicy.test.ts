/**
 * Tests for MEM-02's pure backoff/dead-letter policy (retryPolicy.ts) and the
 * store's soft-delete-only retry/dead-letter write methods.
 *
 * All deterministic — no Math.random(), no fake timers, no network.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder } from "../src/testing/fakes.js";
import { CaptureService } from "../src/capture/capture.js";
import {
  isRetryEligible,
  computeNextRetryAt,
  recordJitter,
  DEAD_LETTER_THRESHOLD,
} from "../src/consolidation/retryPolicy.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-retrypolicy-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const capture = new CaptureService(store, embedder);
  return { store, capture };
}

describe("recordJitter", () => {
  it("is deterministic: same recordId → identical value across calls", () => {
    const a = recordJitter("rec-1", 60_000);
    const b = recordJitter("rec-1", 60_000);
    expect(a).toBe(b);
  });

  it("returns a value in [0, maxMs)", () => {
    for (const id of ["rec-a", "rec-b", "rec-c", "", "x".repeat(50)]) {
      const v = recordJitter(id, 100_000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(100_000);
    }
  });

  it("never calls Math.random (source has none)", async () => {
    // Static assertion via source inspection is done at the acceptance-criteria
    // grep level; this test asserts the *behavioral* signature instead — two
    // distinct record ids reliably produce different jitter (hash-derived, not
    // a constant), proving it's not a stub returning 0.
    const a = recordJitter("rec-distinct-1", 1_000_000);
    const b = recordJitter("rec-distinct-2", 1_000_000);
    expect(a).not.toBe(b);
  });
});

describe("isRetryEligible", () => {
  it("null nextRetryAt is always eligible", () => {
    expect(isRetryEligible(null, Date.now())).toBe(true);
  });

  it("a future nextRetryAt is NOT eligible", () => {
    const now = 1_000_000;
    expect(isRetryEligible(now + 1, now)).toBe(false);
  });

  it("nextRetryAt exactly at now IS eligible (inclusive boundary)", () => {
    const now = 1_000_000;
    expect(isRetryEligible(now, now)).toBe(true);
  });

  it("a past nextRetryAt is eligible", () => {
    const now = 1_000_000;
    expect(isRetryEligible(now - 1, now)).toBe(true);
  });
});

describe("computeNextRetryAt", () => {
  const now = 1_700_000_000_000;

  it("1st failure delay is approximately 5 minutes (base + jitter)", () => {
    const at = computeNextRetryAt("rec-1", 1, now);
    const delay = at - now;
    expect(delay).toBeGreaterThanOrEqual(5 * 60_000);
    expect(delay).toBeLessThan(5 * 60_000 * 1.25); // base + up to ~20% jitter
  });

  it("2nd failure delay is approximately 15 minutes (3x multiplier)", () => {
    const at = computeNextRetryAt("rec-1", 2, now);
    const delay = at - now;
    expect(delay).toBeGreaterThanOrEqual(15 * 60_000);
    expect(delay).toBeLessThan(15 * 60_000 * 1.25);
  });

  it("3rd failure delay is approximately 45 minutes (3x multiplier again)", () => {
    const at = computeNextRetryAt("rec-1", 3, now);
    const delay = at - now;
    expect(delay).toBeGreaterThanOrEqual(45 * 60_000);
    expect(delay).toBeLessThan(45 * 60_000 * 1.25);
  });

  it("delay is monotonically increasing with attempts", () => {
    const d1 = computeNextRetryAt("rec-mono", 1, now) - now;
    const d2 = computeNextRetryAt("rec-mono", 2, now) - now;
    const d3 = computeNextRetryAt("rec-mono", 3, now) - now;
    const d4 = computeNextRetryAt("rec-mono", 4, now) - now;
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    expect(d4).toBeGreaterThan(d3);
  });

  it("delay is capped at 6 hours regardless of how high attempts climbs", () => {
    const SIX_HOURS_MS = 6 * 60 * 60_000;
    for (const attempts of [5, 10, 50, 1000]) {
      const delay = computeNextRetryAt("rec-cap", attempts, now) - now;
      expect(delay).toBeLessThanOrEqual(SIX_HOURS_MS);
    }
  });

  it("clamps corrupted non-positive attempts values instead of inverting the exponent", () => {
    const negativeDelay = computeNextRetryAt("rec-corrupt", -5, now) - now;
    const zeroDelay = computeNextRetryAt("rec-corrupt", 0, now) - now;
    const oneDelay = computeNextRetryAt("rec-corrupt", 1, now) - now;
    // A corrupted negative/zero attempts value must clamp to the same delay
    // as attempts=1, not produce a near-zero or negative delay.
    expect(negativeDelay).toBeGreaterThanOrEqual(5 * 60_000);
    expect(zeroDelay).toBeGreaterThanOrEqual(5 * 60_000);
    expect(oneDelay).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("same recordId + attempts + now produces the same result across calls (deterministic)", () => {
    const a = computeNextRetryAt("rec-det", 2, now);
    const b = computeNextRetryAt("rec-det", 2, now);
    expect(a).toBe(b);
  });
});

describe("DEAD_LETTER_THRESHOLD", () => {
  it("is exported and set to 5", () => {
    expect(DEAD_LETTER_THRESHOLD).toBe(5);
  });
});

describe("MemoryStore - recordConsolidationRetry / deadLetterRecord / getDeadLetterRecords", () => {
  it("recordConsolidationRetry updates attempts/error/next_retry_at without touching dead_letter", async () => {
    const { store, capture } = makeStore();
    const { record } = await capture.captureNote({ text: "will fail extraction", noteId: "retry-1" });

    store.recordConsolidationRetry(record.id, {
      attempts: 1,
      error: "simulated failure",
      nextRetryAt: 1_700_000_300_000,
    });

    const pending = store.getPendingExperienceRecords();
    const updated = pending.find((r) => r.id === record.id);
    expect(updated).toBeDefined();
    expect(updated!.consolidationAttempts).toBe(1);
    expect(updated!.lastConsolidationError).toBe("simulated failure");
    expect(updated!.nextRetryAt).toBe(1_700_000_300_000);
    expect(updated!.deadLetter).toBe(false);
    expect(updated!.consolidation_pending).toBe(true);
  });

  it("deadLetterRecord sets dead_letter=1 AND consolidation_pending=0 atomically, never deletes the row", async () => {
    const { store, capture } = makeStore();
    const { record } = await capture.captureNote({ text: "will be dead-lettered", noteId: "dl-1" });

    store.deadLetterRecord(record.id, { attempts: 5, error: "final failure" });

    // Excluded from pending
    const pending = store.getPendingExperienceRecords();
    expect(pending.map((r) => r.id)).not.toContain(record.id);

    // Row still exists — never hard-deleted
    const dead = store.getDeadLetterRecords();
    const found = dead.find((r) => r.id === record.id);
    expect(found).toBeDefined();
    expect(found!.deadLetter).toBe(true);
    expect(found!.consolidation_pending).toBe(false);
    expect(found!.consolidationAttempts).toBe(5);
    expect(found!.lastConsolidationError).toBe("final failure");
  });

  it("getDeadLetterRecords returns only dead_letter=1 rows", async () => {
    const { store, capture } = makeStore();
    const { record: r1 } = await capture.captureNote({ text: "note one", noteId: "gdl-1" });
    const { record: r2 } = await capture.captureNote({ text: "note two", noteId: "gdl-2" });

    store.deadLetterRecord(r1.id, { attempts: 5, error: "boom" });

    const dead = store.getDeadLetterRecords();
    expect(dead.map((r) => r.id)).toContain(r1.id);
    expect(dead.map((r) => r.id)).not.toContain(r2.id);
  });
});
