/**
 * bargeIn.test.ts
 *
 * Tests for the barge-in policy:
 *  - speech_start during speaking → cancel TTS + abort LLM + →listening
 *  - speech_start during listening → no-op (wrong state)
 *  - debounce window suppresses early barge-in
 *  - Pure shouldActOn() without side effects
 */

import { describe, it, expect, vi } from "vitest";
import { BargeInPolicy } from "../src/bargeIn.js";
import type { BargeInHooks } from "../src/bargeIn.js";

function makeHooks(): { hooks: BargeInHooks; counts: Record<string, number> } {
  const counts = {
    cancelTts: 0,
    cancelLlm: 0,
    transitionToListening: 0,
    markBargedIn: 0,
  };
  const hooks: BargeInHooks = {
    cancelTts: () => { counts.cancelTts++; },
    cancelLlm: () => { counts.cancelLlm++; },
    transitionToListening: () => { counts.transitionToListening++; },
    markBargedIn: () => { counts.markBargedIn++; },
  };
  return { hooks, counts };
}

describe("BargeInPolicy — speech_start during speaking", () => {
  it("acts when state is speaking", () => {
    const policy = new BargeInPolicy({ debounceMs: 150 });
    policy.onSpeakingStarted(0);

    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("speaking", hooks, 300); // well outside debounce

    expect(result.acted).toBe(true);
    expect(result.reason).toBe("acted");
    expect(counts.cancelTts).toBe(1);
    expect(counts.cancelLlm).toBe(1);
    expect(counts.transitionToListening).toBe(1);
    expect(counts.markBargedIn).toBe(1);
  });

  it("cancels TTS before LLM (order of hook calls)", () => {
    const policy = new BargeInPolicy();
    policy.onSpeakingStarted(0);
    const callOrder: string[] = [];
    const hooks: BargeInHooks = {
      cancelTts: () => callOrder.push("tts"),
      cancelLlm: () => callOrder.push("llm"),
      transitionToListening: () => callOrder.push("transition"),
      markBargedIn: () => callOrder.push("mark"),
    };
    policy.evaluate("speaking", hooks, 1000);
    expect(callOrder[0]).toBe("tts");
    expect(callOrder[1]).toBe("llm");
  });

  it("acts when state is thinking (early barge-in)", () => {
    const policy = new BargeInPolicy({ debounceMs: 0 });
    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("thinking", hooks, Date.now());
    expect(result.acted).toBe(true);
    expect(counts.cancelTts).toBe(1);
    expect(counts.transitionToListening).toBe(1);
  });
});

describe("BargeInPolicy — speech_start during listening (wrong state)", () => {
  it("does NOT act when state is listening", () => {
    const policy = new BargeInPolicy();
    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("listening", hooks, Date.now());
    expect(result.acted).toBe(false);
    expect(result.reason).toBe("wrong_state");
    expect(counts.cancelTts).toBe(0);
    expect(counts.cancelLlm).toBe(0);
    expect(counts.transitionToListening).toBe(0);
  });

  it("does NOT act when state is idle", () => {
    const policy = new BargeInPolicy();
    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("idle", hooks, Date.now());
    expect(result.acted).toBe(false);
    expect(result.reason).toBe("wrong_state");
    expect(counts.cancelTts).toBe(0);
  });

  it("does NOT act when state is waking", () => {
    const policy = new BargeInPolicy();
    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("waking", hooks, Date.now());
    expect(result.acted).toBe(false);
  });
});

describe("BargeInPolicy — debounce window", () => {
  it("suppresses barge-in within debounceMs of speaking start", () => {
    const policy = new BargeInPolicy({ debounceMs: 150 });
    const speakingStartedAt = 1000;
    policy.onSpeakingStarted(speakingStartedAt);

    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("speaking", hooks, speakingStartedAt + 100); // within 150ms

    expect(result.acted).toBe(false);
    expect(result.reason).toBe("debounce");
    expect(counts.cancelTts).toBe(0);
  });

  it("acts just after the debounce window", () => {
    const policy = new BargeInPolicy({ debounceMs: 150 });
    const speakingStartedAt = 1000;
    policy.onSpeakingStarted(speakingStartedAt);

    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("speaking", hooks, speakingStartedAt + 151); // just outside

    expect(result.acted).toBe(true);
    expect(counts.cancelTts).toBe(1);
  });

  it("acts at exactly debounceMs boundary (exclusive lower bound)", () => {
    const policy = new BargeInPolicy({ debounceMs: 150 });
    policy.onSpeakingStarted(1000);

    const { hooks: hooks1 } = makeHooks();
    const atBoundary = policy.evaluate("speaking", hooks1, 1150); // diff = 150, NOT < 150
    expect(atBoundary.acted).toBe(true);
  });

  it("does not suppress when no speaking start was recorded", () => {
    const policy = new BargeInPolicy({ debounceMs: 150 });
    // No onSpeakingStarted() call
    const { hooks, counts } = makeHooks();
    const result = policy.evaluate("speaking", hooks, Date.now());
    expect(result.acted).toBe(true);
    expect(counts.cancelTts).toBe(1);
  });
});

describe("BargeInPolicy — cancelLlm config", () => {
  it("does not call cancelLlm when cancelLlm=false", () => {
    const policy = new BargeInPolicy({ cancelLlm: false, debounceMs: 0 });
    policy.onSpeakingStarted(0);
    const { hooks, counts } = makeHooks();
    policy.evaluate("speaking", hooks, 1000);
    expect(counts.cancelTts).toBe(1);
    expect(counts.cancelLlm).toBe(0); // not called
    expect(counts.transitionToListening).toBe(1);
  });

  it("calls cancelLlm when cancelLlm=true (default)", () => {
    const policy = new BargeInPolicy({ debounceMs: 0 });
    const { hooks, counts } = makeHooks();
    policy.evaluate("speaking", hooks, Date.now());
    expect(counts.cancelLlm).toBe(1);
  });
});

describe("BargeInPolicy — pure shouldActOn()", () => {
  it("returns acted=true for speaking state with sufficient elapsed time", () => {
    const policy = new BargeInPolicy({ debounceMs: 100 });
    const result = policy.shouldActOn("speaking", 1500, 1000);
    expect(result.acted).toBe(true);
    expect(result.reason).toBe("acted");
  });

  it("returns debounce for speaking state within debounce window", () => {
    const policy = new BargeInPolicy({ debounceMs: 200 });
    const result = policy.shouldActOn("speaking", 1100, 1000);
    expect(result.acted).toBe(false);
    expect(result.reason).toBe("debounce");
  });

  it("returns wrong_state for idle", () => {
    const policy = new BargeInPolicy();
    const result = policy.shouldActOn("idle", Date.now(), null);
    expect(result.acted).toBe(false);
    expect(result.reason).toBe("wrong_state");
  });

  it("treats null speakingStartedAt as no debounce in pure method", () => {
    const policy = new BargeInPolicy({ debounceMs: 5000 });
    const result = policy.shouldActOn("speaking", Date.now(), null);
    expect(result.acted).toBe(true);
  });
});

describe("BargeInPolicy — state cleanup after act", () => {
  it("clears speakingStartedAt after acting so second barge-in is not debounced", () => {
    const policy = new BargeInPolicy({ debounceMs: 150 });
    policy.onSpeakingStarted(1000);

    // First barge-in acts and clears state
    const { hooks: h1 } = makeHooks();
    policy.evaluate("speaking", h1, 1200);

    // Second barge-in — no speakingStartedAt set, so no debounce
    const { hooks: h2, counts: c2 } = makeHooks();
    policy.evaluate("speaking", h2, 1250);
    expect(c2.cancelTts).toBe(1);
  });

  it("onSpeakingStopped clears speaking start (no debounce after stop)", () => {
    const policy = new BargeInPolicy({ debounceMs: 5000 });
    policy.onSpeakingStarted(1000);
    policy.onSpeakingStopped();

    const { hooks, counts } = makeHooks();
    policy.evaluate("speaking", hooks, 1001); // would be debounced if start was set
    expect(counts.cancelTts).toBe(1); // no debounce — start was cleared
  });
});
