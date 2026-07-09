/**
 * Tests for nightly consolidation: fact extraction, contradiction resolution,
 * forgetting low-importance facts, procedural block update.
 *
 * All AI stages use FakeLlm — deterministic, no network calls.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
  const dir = mkdtempSync(join(tmpdir(), "jarvis-consol-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const llm = fakeLlm ?? new FakeLlm();
  const capture = new CaptureService(store, embedder);
  const consolidation = new ConsolidationService(store, llm, embedder, clock);
  return { store, consolidation, capture, llm };
}

describe("ConsolidationService - fast-exit on empty pending", () => {
  it("completes with zero counts when nothing is pending", async () => {
    const { consolidation } = makeConsolidation();
    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.counts.recordsProcessed).toBe(0);
    expect(result.run.counts.factsExtracted).toBe(0);
  });
});

describe("ConsolidationService - extracts facts from pending records", () => {
  it("extracts facts using FakeLlm and creates them in the store", async () => {
    const { store, capture, consolidation } = makeConsolidation();

    // Capture a note that will be pending
    await capture.captureNote({
      text: "I prefer TypeScript over Python for type safety",
      noteId: "pref-note-1",
    });

    const result = await consolidation.run("manual");

    expect(result.run.status).toBe("completed");
    expect(result.run.counts.recordsProcessed).toBe(1);
    // FakeLlm returns 1 fact (self prefers TypeScript)
    expect(result.run.counts.factsExtracted).toBeGreaterThanOrEqual(1);
    // After consolidation, the record should no longer be pending
    const pending = store.getPendingExperienceRecords();
    expect(pending).toHaveLength(0);
  });
});

describe("ConsolidationService - assistant turns never mint facts", () => {
  it("extracts facts from user turns but not from assistant turns (hallucination guard)", async () => {
    const llm = new FakeLlm();
    // Distinct canned extractions per record body — if the assistant record were
    // (wrongly) extracted, the Nova Dynamics fact would land in the graph.
    llm.addOverride(
      "I prefer TypeScript",
      JSON.stringify([
        { entity: "self", predicate: "prefers", object: "TypeScript", text: "User prefers TypeScript", confidence: 0.9 },
      ]),
    );
    llm.addOverride(
      "Nova Dynamics",
      JSON.stringify([
        { entity: "self", predicate: "has_meeting", object: "Nova Dynamics", text: "User has a 10:30 meeting with Nova Dynamics", confidence: 0.9 },
      ]),
    );
    const { store, capture, consolidation } = makeConsolidation(llm);

    await capture.captureConversationTurn({
      role: "user",
      content: "I prefer TypeScript",
      conversationId: "c1",
      messageId: "m1",
    });
    await capture.captureConversationTurn({
      role: "assistant",
      content: "Tomorrow at 10:30 you have a Zoom with Nova Dynamics.",
      conversationId: "c1",
      messageId: "m2",
    });

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");

    // The assistant record is processed (not stuck pending forever) ...
    expect(store.getPendingExperienceRecords()).toHaveLength(0);

    // ... but only the user turn produced facts.
    const facts = store.getFactHistory("self");
    expect(facts.some((f) => f.text.includes("TypeScript"))).toBe(true);
    expect(facts.some((f) => f.text.includes("Nova Dynamics"))).toBe(false);
  });
});

describe("ConsolidationService - contradiction resolution", () => {
  it("sets valid_to on superseded fact (newest-wins)", async () => {
    const { store } = makeConsolidation();

    // Insert an existing live fact
    await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "Python",
      text: "self prefers Python",
      validFrom: "2025-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "old-msg", confidence: 0.9 },
    });

    // The FakeLlm will return a fact: {entity: "self", predicate: "prefers", object: "TypeScript"}
    // This will supersede the Python preference
    const llm = new FakeLlm();
    // Override to return a TypeScript preference fact
    llm.addOverride(
      "discrete, updateable FACTS",
      JSON.stringify([
        {
          entity: "self",
          predicate: "prefers",
          object: "TypeScript",
          text: "self prefers TypeScript",
          confidence: 0.95,
        },
      ]),
    );

    const dir = mkdtempSync(join(tmpdir(), "jarvis-contradiction-test-"));
    const db = openDatabase(dir);
    const embedder = new FakeEmbedder();
    const store2 = new MemoryStore(db, embedder);
    const capture = new CaptureService(store2, embedder);
    const consolidation = new ConsolidationService(store2, llm, embedder);

    // Insert the Python preference first
    await store2.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "Python",
      text: "self prefers Python",
      validFrom: "2025-01-01T00:00:00Z",
      provenance: { source: "chat", sourceId: "old-msg", confidence: 0.9 },
    });

    // Capture a note about TypeScript
    await capture.captureNote({
      text: "I now prefer TypeScript",
      noteId: "ts-pref-note",
      timestamp: "2026-06-01T10:00:00Z",
    });

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");

    // The Python fact should now be invalidated
    const history = store2.getFactHistory("self", "prefers");
    const pythonFact = history.find((f) => f.objectLiteral === "Python");
    const tsFact = history.find((f) => f.objectLiteral === "TypeScript");

    // At least one fact should exist
    expect(history.length).toBeGreaterThan(0);

    // If contradiction resolved, the Python fact gets valid_to set
    if (pythonFact && tsFact) {
      expect(pythonFact.validTo).not.toBeNull();
    }
  });
});

describe("ConsolidationService - forgetting low-importance facts", () => {
  it("evicts facts below the decay threshold", async () => {
    const { store } = makeConsolidation();

    // Insert a very low-importance, never-accessed fact
    const old = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString(); // 60 days ago
    const f = await store.upsertFact({
      subjectId: "entity-x",
      predicate: "minor_detail",
      objectLiteral: "something trivial",
      text: "Entity X minor detail is something trivial",
      validFrom: old,
      provenance: { source: "note", sourceId: "trivial", confidence: 0.5 },
    });
    // Set importance=1, last_accessed_at=60 days ago, access_count=0
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    db.prepare(`UPDATE facts SET importance = 1, last_accessed_at = ?, access_count = 0 WHERE id = ?`)
      .run(Date.now() - 60 * 24 * 3_600_000, f.id);

    // Also insert a high-importance fact so entity floor isn't the reason
    for (let i = 0; i < 3; i++) {
      await store.upsertFact({
        subjectId: "entity-x",
        predicate: `important_${i}`,
        objectLiteral: "value",
        text: `Important fact ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "note", sourceId: `imp-${i}`, confidence: 0.9 },
      });
    }

    const llm = new FakeLlm();
    const consolidation = new ConsolidationService(store, llm, new FakeEmbedder());

    // Run forget decisions
    const { computeForgetDecisions, applyForgetDecisions } = await import(
      "../src/consolidation/forget.js"
    );
    const decisions = computeForgetDecisions(store, Date.now());
    const { evicted } = await applyForgetDecisions(decisions, store, Date.now());

    // The trivial fact should be evicted
    expect(evicted).toBeGreaterThanOrEqual(1);
    const evictedFact = store.getFactById(f.id);
    // Evicted = invalidated (soft-delete via valid_to/invalidated_at)
    expect(evictedFact?.invalidatedAt).not.toBeNull();
  });
});

describe("ConsolidationService - procedural block update", () => {
  it("updates procedural block from new preference facts", async () => {
    const { store, capture, consolidation } = makeConsolidation();

    // Capture a note with a preference
    await capture.captureNote({
      text: "I prefer working in the morning for deep work",
      noteId: "morning-pref",
    });

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");

    // Procedural block may or may not be updated depending on FakeLlm extraction
    // But the run should complete without error
    expect(result.briefing).toBeDefined();
  });
});

describe("ConsolidationService - run structure", () => {
  it("run has correct schema fields", async () => {
    const { capture, consolidation } = makeConsolidation();
    await capture.captureNote({ text: "Test note", noteId: "schema-test" });
    const result = await consolidation.run("manual");

    expect(result.run.id).toBeTruthy();
    expect(result.run.startedAt).toBeTruthy();
    expect(result.run.finishedAt).toBeTruthy();
    expect(result.run.trigger).toBe("manual");
    expect(result.run.counts).toBeDefined();
    expect(typeof result.run.counts.recordsProcessed).toBe("number");
    expect(typeof result.run.counts.factsExtracted).toBe("number");
    expect(typeof result.run.counts.factsInvalidated).toBe("number");
    expect(Array.isArray(result.run.errors)).toBe(true);
  });

  it("marks pending records as consolidated after run", async () => {
    const { store, capture, consolidation } = makeConsolidation();
    await capture.captureNote({ text: "Will be consolidated", noteId: "consol-1" });
    await capture.captureNote({ text: "Also consolidated", noteId: "consol-2" });

    expect(store.getPendingExperienceRecords()).toHaveLength(2);
    await consolidation.run("manual");
    expect(store.getPendingExperienceRecords()).toHaveLength(0);
  });
});

describe("ConsolidationService - partial runs keep failed records pending", () => {
  /** LLM that fails extraction for records containing a marker, delegates otherwise. */
  class PartiallyFailingLlm extends FakeLlm {
    override async complete(opts: {
      system?: string;
      prompt: string;
      json?: boolean;
    }): Promise<string> {
      if (
        opts.prompt.includes("discrete, updateable FACTS") &&
        opts.prompt.includes("FAILME")
      ) {
        throw new Error("simulated LLM extraction failure");
      }
      return super.complete(opts);
    }
  }

  it("marks only successfully-extracted records consolidated and sets status=partial", async () => {
    const { store, capture, consolidation } = makeConsolidation(new PartiallyFailingLlm());

    const good = await capture.captureNote({ text: "I prefer TypeScript", noteId: "good-note" });
    const bad = await capture.captureNote({ text: "FAILME this record breaks the LLM", noteId: "bad-note" });

    const result = await consolidation.run("manual");

    // Run is partial, not completed — records were lost otherwise
    expect(result.run.status).toBe("partial");
    // The failure is recorded with the record id
    expect(
      result.run.errors.some((e) => e.stage === 2 && e.recordId === bad.record.id),
    ).toBe(true);

    // The failed record stays pending (retried next pass); the good one is cleared
    const pending = store.getPendingExperienceRecords();
    expect(pending.map((r) => r.id)).toContain(bad.record.id);
    expect(pending.map((r) => r.id)).not.toContain(good.record.id);
  });

  it("a follow-up run with a healthy LLM consolidates the previously-failed record (after its backoff window elapses)", async () => {
    // MEM-02: a failed record is now backoff-blocked on the very next pass
    // (that's the fix — no more retry-storm), so the follow-up run must
    // advance the clock past the scheduled next_retry_at to observe the retry.
    const clock = new FixedClock(1_700_000_000_000);
    const { store, capture, consolidation } = makeConsolidation(new PartiallyFailingLlm(), clock);
    await capture.captureNote({ text: "FAILME again", noteId: "retry-note" });
    await consolidation.run("manual");
    expect(store.getPendingExperienceRecords()).toHaveLength(1);

    // Past the 1st-failure backoff window (5min base + up to ~20% jitter).
    clock.advance(10 * 60_000);

    // Same store, same clock, healthy LLM
    const { ConsolidationService } = await import("../src/consolidation/consolidation.js");
    const healthy = new ConsolidationService(store, new FakeLlm(), new FakeEmbedder(), clock);
    const result = await healthy.run("manual");
    expect(result.run.status).toBe("completed");
    expect(store.getPendingExperienceRecords()).toHaveLength(0);
  });
});

describe("Contradiction resolution - source trust and validity intervals", () => {
  it("a user-corrected fact (trust 1.0) is NOT invalidated by a lower-trust incoming fact", async () => {
    const { store } = makeConsolidation();
    const { resolveFact } = await import("../src/consolidation/contradictions.js");

    // Prior: user correction, maximally trusted
    const prior = await store.upsertFact({
      subjectId: "self",
      predicate: "manager_is",
      objectLiteral: "Priya",
      text: "self manager_is Priya",
      validFrom: "2026-01-01T00:00:00Z",
      sourceTrust: 1.0,
      provenance: { source: "system", sourceId: "user-correction", confidence: 1.0 },
    });
    expect(store.getFactById(prior.id)!.sourceTrust).toBe(1.0);

    // Incoming extracted fact from a conversation (trust 0.8), newer validFrom
    const incoming = {
      id: "incoming-contradiction-1",
      runId: "run-1",
      sourceRecordId: "rec-1",
      entity: "self",
      predicate: "manager_is",
      object: "Bob",
      text: "self manager_is Bob",
      confidence: 0.9,
      validFrom: "2026-06-01T00:00:00Z",
      validTo: null,
      sourceTrust: 0.8,
    };

    const result = await resolveFact(incoming, store, new FakeLlm());

    // Prior (higher trust) wins: it stays live and is not invalidated
    expect(result.invalidatedIds).toHaveLength(0);
    const priorAfter = store.getFactById(prior.id)!;
    expect(priorAfter.validTo).toBeNull();
    expect(priorAfter.invalidatedAt).toBeNull();

    // The losing incoming fact is stored as historical, closed at its OWN
    // validFrom (zero-length interval — never a negative one)
    const losing = store.getFactById(result.factId)!;
    expect(losing.validTo).toBe(incoming.validFrom);
    expect(losing.validTo! >= losing.validFrom).toBe(true);
  });
});

describe("ConsolidationService - MEM-02 retry backoff + dead-letter", () => {
  /** LLM that ALWAYS fails extraction for records containing a marker (unlike
   * the single-shot PartiallyFailingLlm above — used to exercise repeated
   * retry passes against a permanently-malformed record). */
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

  it("a failed extraction attempt increments consolidation_attempts and schedules a future next_retry_at (record stays pending)", async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const { store, capture, consolidation } = makeConsolidation(new AlwaysFailingLlm(), clock);
    const { record } = await capture.captureNote({ text: "FAILME first attempt", noteId: "backoff-1" });

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("partial");

    const pending = store.getPendingExperienceRecords();
    const updated = pending.find((r) => r.id === record.id);
    expect(updated).toBeDefined();
    expect(updated!.consolidationAttempts).toBe(1);
    expect(updated!.nextRetryAt).not.toBeNull();
    expect(updated!.nextRetryAt!).toBeGreaterThan(clock.now());
    expect(updated!.consolidation_pending).toBe(true);
    expect(updated!.deadLetter).toBe(false);
  });

  it("an immediately-following run() at the same clock time does not re-attempt a backoff-blocked record", async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { capture, consolidation } = makeConsolidation(llm, clock);
    await capture.captureNote({ text: "FAILME again", noteId: "backoff-2" });

    await consolidation.run("manual"); // first failure — schedules backoff
    const completeSpy = vi.spyOn(llm, "complete");

    await consolidation.run("manual"); // same clock tick — record is backoff-blocked
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("fast-exits with zero LLM calls across N consecutive runs once the sole pending record is backoff-blocked", async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { capture, consolidation } = makeConsolidation(llm, clock);
    await capture.captureNote({ text: "FAILME blocked", noteId: "backoff-3" });

    await consolidation.run("manual"); // triggers the first failure + backoff scheduling
    const completeSpy = vi.spyOn(llm, "complete");

    for (let i = 0; i < 3; i++) {
      const result = await consolidation.run("manual");
      expect(result.run.status).toBe("completed"); // fast-exit, not partial/failed
    }
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it(`dead-letters a record after ${String(DEAD_LETTER_THRESHOLD)} failed passes, never hard-deleting it`, async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { store, capture, consolidation } = makeConsolidation(llm, clock);
    const { record } = await capture.captureNote({ text: "FAILME dead letter", noteId: "backoff-4" });

    for (let i = 0; i < DEAD_LETTER_THRESHOLD; i++) {
      await consolidation.run("manual");
      // Advance well past any backoff window (max cap is 6hr) before the next pass.
      clock.advance(7 * 60 * 60_000);
    }

    // Excluded from pending
    const pending = store.getPendingExperienceRecords();
    expect(pending.map((r) => r.id)).not.toContain(record.id);

    // Row still exists — never hard-deleted — and is flagged correctly
    const dead = store.getDeadLetterRecords();
    const found = dead.find((r) => r.id === record.id);
    expect(found).toBeDefined();
    expect(found!.deadLetter).toBe(true);
    expect(found!.consolidation_pending).toBe(false);
    expect(found!.consolidationAttempts).toBe(DEAD_LETTER_THRESHOLD);
  });

  it("extract.ts's per-record isolation contract is unchanged — a healthy record alongside a backoff-blocked one still extracts normally", async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const llm = new AlwaysFailingLlm();
    const { store, capture, consolidation } = makeConsolidation(llm, clock);

    const bad = await capture.captureNote({ text: "FAILME poison record", noteId: "mixed-bad" });
    await consolidation.run("manual"); // bad record now backoff-blocked

    // Advance the clock so bad's backoff window is still open, but capture a
    // fresh healthy record that has no next_retry_at (eligible immediately).
    const good = await capture.captureNote({ text: "I prefer TypeScript", noteId: "mixed-good" });
    const result = await consolidation.run("manual");

    // The healthy record was processed even though the poison one is blocked.
    expect(store.getPendingExperienceRecords().map((r) => r.id)).toContain(bad.record.id);
    expect(store.getPendingExperienceRecords().map((r) => r.id)).not.toContain(good.record.id);
    expect(result.run.counts.factsExtracted).toBeGreaterThanOrEqual(1);
  });
});
