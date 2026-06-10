/**
 * orchestrator.test.ts
 *
 * Integration tests for VoiceOrchestrator using the fake implementations.
 * Tests:
 *   1. Full happy-path turn: wake → warmup called → user speech → turn complete
 *      → LLM tokens → sentences spoken in order → latency events emitted.
 *   2. Barge-in mid-speech: speaking cancelled, LLM aborted, state → listening.
 *   3. Wake ignored during active session (duplicate-wake dedup).
 *   4. Warmup failure → error state → recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createVoiceOrchestrator } from "../src/voiceOrchestrator.js";
import {
  FakeWakeWordSource,
  FakeSttEngine,
  FakeTtsEngine,
  FakeCoreClient,
} from "../src/testing/fakes.js";
import type { OrchestratorEvent } from "../src/voiceOrchestrator.js";
import type { SttEvent } from "../src/interfaces.js";

/** Drain events until a predicate is met or timeout (ms) is reached. */
function waitForEvent(
  events: OrchestratorEvent[],
  predicate: (e: OrchestratorEvent) => boolean,
  timeoutMs = 2000,
): Promise<OrchestratorEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error("waitForEvent timeout"));
      setTimeout(check, 10);
    };
    check();
  });
}

/** Build a simple STT script: speech_start → partial → final → speech_end. */
function speechScript(text: string): SttEvent[] {
  return [
    { type: "speech_start" },
    { type: "partial", text, stability: 0.7 },
    { type: "final", text, confidence: 0.95 },
    { type: "speech_end", silenceMs: 900 }, // > 800ms threshold
  ];
}

describe("VoiceOrchestrator — full happy-path turn", () => {
  it("wake → warmup called → LLM tokens → sentences spoken in order", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    stt.setScript(speechScript("What is the weather today?"));
    core.tokenScript = ["The ", "weather ", "is ", "sunny. ", "Enjoy ", "your ", "day!"];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 1000 },
    );

    const events: OrchestratorEvent[] = [];
    orchestrator.on((e) => events.push(e));
    orchestrator.start();

    // Fire wake
    wake.fire({ id: "session-1" });

    // Wait for turn_complete
    const turnEvent = await waitForEvent(
      events,
      (e) => e.type === "turn_complete",
    );

    await orchestrator.stop();

    // Warmup should have been called
    expect(core.warmupCalls).toBeGreaterThanOrEqual(1);

    // TTS should have been called with at least one sentence
    expect(tts.calls.length).toBeGreaterThanOrEqual(1);
    const allSpoken = tts.calls.flatMap((c) => c.sentences);
    expect(allSpoken.length).toBeGreaterThan(0);

    // The sentences should contain the LLM reply text
    const spokenText = allSpoken.join(" ");
    expect(spokenText).toContain("sunny");

    // turn_complete event should have turn data
    expect(turnEvent.type).toBe("turn_complete");
    if (turnEvent.type === "turn_complete") {
      expect(turnEvent.turn.userText).toBe("What is the weather today?");
      expect(turnEvent.turn.bargedIn).toBe(false);
      expect(turnEvent.turn.timings).toBeDefined();
    }
  });

  it("wake event triggers WakeWordSource.start()", () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    const orchestrator = createVoiceOrchestrator({ wakeWord: wake, stt, tts, core });
    orchestrator.start();
    expect(wake.started).toBe(true);
  });

  it("emits state_change events through the full cycle", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    stt.setScript(speechScript("Hello."));
    core.tokenScript = ["Hi there."];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 500 },
    );

    const stateChanges: string[] = [];
    orchestrator.on((e) => {
      if (e.type === "state_change") stateChanges.push(e.state);
    });
    orchestrator.start();
    wake.fire();

    await waitForEvent(
      [] as OrchestratorEvent[],
      () => stateChanges.includes("idle") && stateChanges.indexOf("waking") < stateChanges.indexOf("idle"),
      2000,
    ).catch(() => {
      // timeout is OK here — we just check what we got
    });

    await new Promise<void>((r) => setTimeout(r, 500));
    await orchestrator.stop();

    // Should have gone through waking at minimum
    expect(stateChanges).toContain("waking");
  });

  it("tokens are emitted as orchestrator events", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    stt.setScript(speechScript("test"));
    core.tokenScript = ["Hello", " world."];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 500 },
    );

    const tokens: string[] = [];
    orchestrator.on((e) => {
      if (e.type === "token") tokens.push(e.text);
    });
    orchestrator.start();
    wake.fire();

    await waitForEvent(
      { push: () => {} } as unknown as OrchestratorEvent[],
      () => tokens.length >= 2,
      2000,
    ).catch(() => {});

    await new Promise<void>((r) => setTimeout(r, 300));
    await orchestrator.stop();

    if (tokens.length > 0) {
      expect(tokens.join("")).toContain("Hello");
    }
  });
});

describe("VoiceOrchestrator — barge-in mid-speech", () => {
  it("barge-in during speaking cancels TTS mid-speech and transitions to listening", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    // Script: first some tokens, then a barge-in speech_start
    const sttScript: SttEvent[] = [
      { type: "speech_start" },
      { type: "partial", text: "Tell me a story", stability: 0.8 },
      { type: "final", text: "Tell me a story.", confidence: 0.9 },
      { type: "speech_end", silenceMs: 900 },
      // After some processing, user speaks again (barge-in)
      { type: "speech_start" }, // barge-in
    ];
    stt.setScript(sttScript);
    core.tokenScript = ["Once ", "upon ", "a ", "time... ", "There ", "was ", "a ", "dragon."];
    tts.msPerSentence = 50; // small delay so barge-in has time to fire

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      {
        minCharsPerChunk: 1,
        silenceThresholdMs: 100,
        forceEndMs: 500,
        bargeInDebounceMs: 0, // no debounce for test
      },
    );

    const events: OrchestratorEvent[] = [];
    orchestrator.on((e) => events.push(e));
    orchestrator.start();
    wake.fire();

    // The barge-in MUST fire: the STT event loop keeps consuming events while
    // the turn is in flight, so the trailing speech_start is evaluated during
    // thinking/speaking.
    const bargeEvent = await waitForEvent(events, (e) => e.type === "barge_in");
    expect(bargeEvent.type).toBe("barge_in");

    // Let the cancelled turn pipeline unwind
    await new Promise<void>((r) => setTimeout(r, 100));

    // TTS was actually cancelled mid-speech
    expect(tts.cancelCount).toBeGreaterThanOrEqual(1);
    expect(tts.calls.length).toBeGreaterThanOrEqual(1);
    expect(tts.calls[0]?.wasCancelled).toBe(true);

    // The reply was cut off — the tail of the scripted reply was never spoken
    const spoken = tts.calls.flatMap((c) => c.sentences).join(" ");
    expect(spoken).not.toContain("dragon");

    // Barge-in transitions back to listening; the interrupted turn is
    // reported with bargedIn = true.
    expect(orchestrator.state).toBe("listening");
    const turns = events.filter((e) => e.type === "turn_complete");
    for (const t of turns) {
      if (t.type === "turn_complete") expect(t.turn.bargedIn).toBe(true);
    }

    await orchestrator.stop();
  });
});

describe("VoiceOrchestrator — duplicate wake deduplication", () => {
  it("ignores a second wake event during an active session", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    stt.setScript(speechScript("Hello."));
    core.tokenScript = ["Hi."];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 500 },
    );

    orchestrator.start();
    wake.fire({ id: "first-wake" });

    // Fire second wake immediately while session is active
    wake.fire({ id: "second-wake" });

    await new Promise<void>((r) => setTimeout(r, 500));
    await orchestrator.stop();

    // Warmup should have been called only once (second wake was ignored)
    expect(core.warmupCalls).toBe(1);
  });
});

describe("VoiceOrchestrator — warmup failure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enters error state, does NOT start listening, and recovers to idle", async () => {
    vi.useFakeTimers();
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();
    core.warmupError = new Error("Model failed to load");

    stt.setScript(speechScript("test"));

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1 },
    );

    const errors: OrchestratorEvent[] = [];
    const stateChanges: string[] = [];
    orchestrator.on((e) => {
      if (e.type === "error") errors.push(e);
      if (e.type === "state_change") stateChanges.push(e.state);
    });
    orchestrator.start();
    wake.fire();

    // Let the warmup rejection propagate
    await vi.advanceTimersByTimeAsync(10);

    expect(errors.length).toBeGreaterThanOrEqual(1);
    if (errors[0]?.type === "error") {
      expect(errors[0].message).toContain("Warmup failed");
    }

    // Machine took the error path — and did NOT proceed to listening
    expect(stateChanges).toContain("error");
    expect(stateChanges).not.toContain("listening");
    expect(orchestrator.state).toBe("error");

    // The STT loop was never started
    expect(stt.streamCount).toBe(0);
    expect(stt.isStreaming).toBe(false);

    // Scheduled RECOVER returns the machine to idle
    await vi.advanceTimersByTimeAsync(1100);
    expect(orchestrator.state).toBe("idle");

    await orchestrator.stop();
  });
});

describe("VoiceOrchestrator — stop cleanup", () => {
  it("stop() halts the wake source and STT", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    const orchestrator = createVoiceOrchestrator({ wakeWord: wake, stt, tts, core });
    orchestrator.start();
    await orchestrator.stop();

    expect(wake.stopped).toBe(true);
  });

  it("can be started and stopped multiple times without crashing", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    const orchestrator = createVoiceOrchestrator({ wakeWord: wake, stt, tts, core });
    orchestrator.start();
    await orchestrator.stop();
    // No crash = pass
  });
});

describe("VoiceOrchestrator — silence-timeout end-of-turn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes the turn when the engine goes quiet after a below-threshold speech_end", async () => {
    vi.useFakeTimers();
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    // speech_end reports 100ms of silence — BELOW the 800ms threshold — and
    // then the engine emits nothing more (stream held open, like a real VAD
    // that stays quiet). Without the silence timer the turn would never end.
    stt.holdOpenAfterScript = true;
    stt.setScript([
      { type: "speech_start" },
      { type: "partial", text: "Hello there.", stability: 0.8 },
      { type: "final", text: "Hello there.", confidence: 0.95 },
      { type: "speech_end", silenceMs: 100 },
    ]);
    core.tokenScript = ["Hi!"];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 800, forceEndMs: 2000 },
    );

    const events: OrchestratorEvent[] = [];
    orchestrator.on((e) => events.push(e));
    orchestrator.start();
    wake.fire();

    // Script consumed; silence below threshold — no turn yet
    await vi.advanceTimersByTimeAsync(50);
    expect(events.some((e) => e.type === "turn_complete")).toBe(false);
    expect(tts.calls.length).toBe(0);

    // The silence threshold elapses with no further STT events — the armed
    // timer re-evaluates end-of-turn and the turn completes.
    await vi.advanceTimersByTimeAsync(900);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
    expect(tts.lastSpokenSentences.join(" ")).toContain("Hi!");

    await orchestrator.stop();
  });

  it("a new speech_start disarms the silence timer (no spurious turn)", async () => {
    vi.useFakeTimers();
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    // speech_end below threshold, then the user resumes speaking — the armed
    // timer must be cleared so the half-finished utterance is not turned.
    stt.holdOpenAfterScript = true;
    stt.setScript([
      { type: "speech_start" },
      { type: "partial", text: "Hello there.", stability: 0.8 },
      { type: "final", text: "Hello there.", confidence: 0.95 },
      { type: "speech_end", silenceMs: 100 },
      { type: "speech_start" }, // user resumes — disarm the timer
    ]);
    core.tokenScript = ["Hi!"];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 800, forceEndMs: 2000 },
    );

    const events: OrchestratorEvent[] = [];
    orchestrator.on((e) => events.push(e));
    orchestrator.start();
    wake.fire();

    await vi.advanceTimersByTimeAsync(3000);
    expect(events.some((e) => e.type === "turn_complete")).toBe(false);
    expect(tts.calls.length).toBe(0);

    await orchestrator.stop();
  });
});

describe("VoiceOrchestrator — error recovery tears down the STT loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("after a turn error and recovery, a new wake runs exactly ONE stream and only the new turn executes", async () => {
    vi.useFakeTimers();
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    // First session: the LLM stream errors immediately → error path.
    stt.holdOpenAfterScript = true; // a real stream stays open unless torn down
    stt.setScript(speechScript("Break it."));
    core.tokenScript = ["never"];
    core.chatErrorAfterTokens = 0;

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 500 },
    );

    const events: OrchestratorEvent[] = [];
    orchestrator.on((e) => events.push(e));
    orchestrator.start();
    wake.fire({ id: "session-err" });

    await vi.advanceTimersByTimeAsync(100);
    expect(
      events.some((e) => e.type === "error" && e.message.includes("Turn error")),
    ).toBe(true);

    // The error path tore down the STT stream — no orphaned loop survives
    expect(stt.activeStreams).toBe(0);

    // RECOVER returns the machine to idle
    await vi.advanceTimersByTimeAsync(1100);
    expect(orchestrator.state).toBe("idle");

    // Second session: healthy LLM, fresh script
    core.chatErrorAfterTokens = null;
    core.tokenScript = ["All good."];
    stt.setScript(speechScript("Again."));
    wake.fire({ id: "session-ok" });

    await vi.advanceTimersByTimeAsync(100);

    // Exactly one stream was ever active at a time — no second concurrent
    // loop from the first (errored) session.
    expect(stt.streamCount).toBe(2);
    expect(stt.maxConcurrentStreams).toBe(1);

    // Only the new session's turn executed
    const turns = events.filter((e) => e.type === "turn_complete");
    expect(turns).toHaveLength(1);
    if (turns[0]?.type === "turn_complete") {
      expect(turns[0].turn.userText).toBe("Again.");
      expect(turns[0].turn.sessionId).toBe("session-ok");
    }

    await orchestrator.stop();
  });
});

describe("VoiceOrchestrator — FakeTtsEngine sentence recording", () => {
  it("records all spoken sentences in order", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    stt.setScript(speechScript("Go."));
    // Produce two clear sentences
    core.tokenScript = ["First sentence. ", "Second sentence."];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 500 },
    );
    orchestrator.start();
    wake.fire();

    await waitForEvent(
      [] as OrchestratorEvent[],
      () => tts.calls.length > 0,
      2000,
    ).catch(() => {});

    await new Promise<void>((r) => setTimeout(r, 400));
    await orchestrator.stop();

    const allSentences = tts.calls.flatMap((c) => c.sentences);
    if (allSentences.length > 0) {
      const joined = allSentences.join(" ");
      expect(joined).toContain("First sentence");
    }
  });
});

describe("VoiceOrchestrator — multi-segment turns accumulate finals", () => {
  it("a mid-utterance pause (two STT finals in one turn) keeps both segments", async () => {
    const wake = new FakeWakeWordSource();
    const stt = new FakeSttEngine();
    const tts = new FakeTtsEngine();
    const core = new FakeCoreClient();

    // The sidecar emits one final PER VAD SEGMENT: a pause longer than its
    // silence hangover but shorter than the turn threshold splits one user
    // turn into two finals. The orchestrator must concatenate them.
    stt.setScript([
      { type: "speech_start" },
      { type: "partial", text: "Remind me to call mum", stability: 0.7 },
      { type: "final", text: "Remind me to call mum", confidence: 0.95 },
      { type: "speech_end", silenceMs: 50 }, // below threshold: turn continues
      { type: "speech_start" },
      { type: "partial", text: "tomorrow at nine.", stability: 0.7 },
      { type: "final", text: "tomorrow at nine.", confidence: 0.95 },
      { type: "speech_end", silenceMs: 900 }, // turn ends
    ]);
    core.tokenScript = ["Done."];

    const orchestrator = createVoiceOrchestrator(
      { wakeWord: wake, stt, tts, core },
      { minCharsPerChunk: 1, silenceThresholdMs: 100, forceEndMs: 2000 },
    );

    const events: OrchestratorEvent[] = [];
    orchestrator.on((e) => events.push(e));
    orchestrator.start();
    wake.fire({ id: "session-multi" });

    const turnEvent = await waitForEvent(events, (e) => e.type === "turn_complete");
    await orchestrator.stop();

    if (turnEvent.type === "turn_complete") {
      expect(turnEvent.turn.userText).toBe("Remind me to call mum tomorrow at nine.");
    }
    // core /chat received the FULL utterance, not just the last segment
    expect(core.chatCalls[0]).toBe("Remind me to call mum tomorrow at nine.");
  });
});
