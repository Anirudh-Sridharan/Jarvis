/**
 * latency.test.ts
 *
 * Tests for the TurnLatencyTracker: delta computation, budget checks,
 * and the computeLatency() convenience function.
 */

import { describe, it, expect } from "vitest";
import { TurnLatencyTracker, computeLatency } from "../src/latency.js";
import type { BudgetThresholds } from "../src/latency.js";

describe("TurnLatencyTracker — basic delta computation", () => {
  it("computes eosToSttFinalMs correctly", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    tracker.markSttFinal(1080);
    const r = tracker.finish();
    expect(r.eosToSttFinalMs).toBe(80);
  });

  it("computes sttFinalToTtftMs correctly", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    tracker.markSttFinal(1100);
    tracker.markLlmFirstToken(1500);
    const r = tracker.finish();
    expect(r.sttFinalToTtftMs).toBe(400);
  });

  it("computes ttftToFirstAudioMs correctly", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    tracker.markSttFinal(1100);
    tracker.markLlmFirstToken(1500);
    tracker.markFirstAudio(1700);
    const r = tracker.finish();
    expect(r.ttftToFirstAudioMs).toBe(200);
  });

  it("computes eosToFirstAudioMs (headline metric)", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    tracker.markSttFinal(1100);
    tracker.markLlmFirstToken(1500);
    tracker.markFirstAudio(1700);
    const r = tracker.finish();
    expect(r.eosToFirstAudioMs).toBe(700);
  });

  it("computes totalTurnMs", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    tracker.markReplyDone(3500);
    const r = tracker.finish();
    expect(r.totalTurnMs).toBe(2500);
  });

  it("returns null for missing timestamps", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    // sttFinal never called
    const r = tracker.finish();
    expect(r.eosToSttFinalMs).toBeNull();
    expect(r.sttFinalToTtftMs).toBeNull();
    expect(r.ttftToFirstAudioMs).toBeNull();
    expect(r.eosToFirstAudioMs).toBeNull();
    expect(r.totalTurnMs).toBeNull();
  });

  it("preserves raw timestamps in the record", () => {
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos(1000);
    tracker.markSttFinal(1100);
    const r = tracker.finish();
    expect(r.eosAt).toBe(1000);
    expect(r.sttFinalAt).toBe(1100);
  });

  it("includes turnId in the result", () => {
    const tracker = new TurnLatencyTracker("my-turn-id");
    tracker.markEos(0);
    const r = tracker.finish();
    expect(r.turnId).toBe("my-turn-id");
  });

  it("throws if markEos was never called", () => {
    const tracker = new TurnLatencyTracker("t1");
    expect(() => tracker.finish()).toThrow("markEos");
  });
});

describe("TurnLatencyTracker — budget checks", () => {
  const tightBudget: BudgetThresholds = {
    eosToSttFinalWarnMs: 50,
    sttFinalToTtftWarnMs: 200,
    ttftToFirstAudioWarnMs: 100,
    eosToFirstAudioWarnMs: 400,
  };

  it("returns empty violations when within budget", () => {
    const tracker = new TurnLatencyTracker("t1", tightBudget);
    tracker.markEos(0);
    tracker.markSttFinal(40);       // 40ms < 50ms ✓
    tracker.markLlmFirstToken(200); // 160ms < 200ms ✓
    tracker.markFirstAudio(280);    // 80ms < 100ms ✓ ; 280ms < 400ms ✓
    const r = tracker.finish();
    const violations = tracker.checkBudget(r);
    expect(violations).toHaveLength(0);
  });

  it("flags EOS→STT violation", () => {
    const tracker = new TurnLatencyTracker("t1", tightBudget);
    tracker.markEos(0);
    tracker.markSttFinal(60); // 60ms > 50ms budget
    const r = tracker.finish();
    const violations = tracker.checkBudget(r);
    expect(violations.some((v) => v.includes("EOS→STT"))).toBe(true);
  });

  it("flags STT→TTFT violation", () => {
    const tracker = new TurnLatencyTracker("t1", tightBudget);
    tracker.markEos(0);
    tracker.markSttFinal(30);
    tracker.markLlmFirstToken(300); // 270ms > 200ms budget
    const r = tracker.finish();
    const violations = tracker.checkBudget(r);
    expect(violations.some((v) => v.includes("STT→TTFT"))).toBe(true);
  });

  it("flags EOS→audio headline violation", () => {
    const tracker = new TurnLatencyTracker("t1", tightBudget);
    tracker.markEos(0);
    tracker.markSttFinal(30);
    tracker.markLlmFirstToken(200);
    tracker.markFirstAudio(500); // 500ms > 400ms budget
    const r = tracker.finish();
    const violations = tracker.checkBudget(r);
    expect(violations.some((v) => v.includes("EOS→audio"))).toBe(true);
  });

  it("can flag multiple violations at once", () => {
    const tracker = new TurnLatencyTracker("t1", tightBudget);
    tracker.markEos(0);
    tracker.markSttFinal(100);    // EOS→STT violation
    tracker.markLlmFirstToken(400); // STT→TTFT violation
    tracker.markFirstAudio(600);   // all headline violations
    const r = tracker.finish();
    const violations = tracker.checkBudget(r);
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it("skips checks for null deltas (missing timestamps)", () => {
    const tracker = new TurnLatencyTracker("t1", tightBudget);
    tracker.markEos(0);
    // sttFinal never marked — delta is null; should not be flagged
    const r = tracker.finish();
    const violations = tracker.checkBudget(r);
    expect(violations).toHaveLength(0);
  });
});

describe("computeLatency() convenience helper", () => {
  it("computes a full latency record from raw timestamps", () => {
    const r = computeLatency({
      turnId: "t1",
      eosAt: 1000,
      sttFinalAt: 1080,
      llmFirstTokenAt: 1500,
      firstAudioAt: 1700,
      replyDoneAt: 3000,
    });
    expect(r.eosToSttFinalMs).toBe(80);
    expect(r.sttFinalToTtftMs).toBe(420);
    expect(r.ttftToFirstAudioMs).toBe(200);
    expect(r.eosToFirstAudioMs).toBe(700);
    expect(r.totalTurnMs).toBe(2000);
  });

  it("handles missing optional timestamps gracefully", () => {
    const r = computeLatency({ turnId: "t2", eosAt: 1000 });
    expect(r.eosToSttFinalMs).toBeNull();
    expect(r.eosToFirstAudioMs).toBeNull();
    expect(r.totalTurnMs).toBeNull();
  });

  it("preserves turnId", () => {
    const r = computeLatency({ turnId: "abc-123", eosAt: 0 });
    expect(r.turnId).toBe("abc-123");
  });
});

describe("TurnLatencyTracker — default timestamps", () => {
  it("uses Date.now() when no ts argument provided", () => {
    const before = Date.now();
    const tracker = new TurnLatencyTracker("t1");
    tracker.markEos();
    const after = Date.now();
    const r = tracker.finish();
    expect(r.eosAt).toBeGreaterThanOrEqual(before);
    expect(r.eosAt).toBeLessThanOrEqual(after + 5);
  });
});
