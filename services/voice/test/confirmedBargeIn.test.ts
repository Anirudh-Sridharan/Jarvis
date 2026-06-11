/**
 * confirmedBargeIn.test.ts
 *
 * Echo-resistant barge-in (bargeInMode: "confirmed", the default):
 *  1. An echo final during speaking is dropped — reply plays to completion.
 *  2. A genuine final during speaking confirms barge-in and becomes the next turn.
 *  3. A trailing echo final in a NEW session (wake right after a reply) is
 *     dropped — Jarvis never replies to himself.
 *  4. bargeInMode: "immediate" preserves the old speech_start-cancels behavior.
 *
 * Timing: sessions are single-turn and speaking only lasts as long as the
 * fake TTS plays, so mid-reply events are pushed from a LIVE state_change
 * listener (not after-the-fact polling) and replies are multi-sentence.
 */
import { describe, it, expect } from "vitest";
import { createVoiceOrchestrator } from "../src/voiceOrchestrator.js";
import {
  FakeWakeWordSource,
  FakeSttEngine,
  FakeTtsEngine,
  FakeCoreClient,
} from "../src/testing/fakes.js";
import type {
  OrchestratorConfig,
  OrchestratorEvent,
  VoiceOrchestrator,
} from "../src/voiceOrchestrator.js";
import type { SttEvent } from "../src/interfaces.js";

function waitFor(
  events: OrchestratorEvent[],
  predicate: (e: OrchestratorEvent) => boolean,
  timeoutMs = 3000,
): Promise<OrchestratorEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error("waitFor timeout"));
      setTimeout(check, 10);
    };
    check();
  });
}

/** Run `cb` once, the moment the orchestrator transitions into `state`. */
function onceState(
  orchestrator: VoiceOrchestrator,
  state: string,
  cb: () => void,
): void {
  const unsubscribe = orchestrator.on((e) => {
    if (e.type === "state_change" && e.state === state) {
      unsubscribe();
      cb();
    }
  });
}

function userSpeech(text: string): SttEvent[] {
  return [
    { type: "speech_start" },
    { type: "partial", text, stability: 0.7 },
    { type: "final", text, confidence: 0.95 },
    { type: "speech_end", silenceMs: 900 },
  ];
}

/** Five short sentences with terminator+space so the chunker streams them. */
const FIVE_SENTENCE_TOKENS = ["One. ", "Two. ", "Three. ", "Four. ", "Five."];

function setup(config: OrchestratorConfig = {}) {
  const wake = new FakeWakeWordSource();
  const stt = new FakeSttEngine();
  const tts = new FakeTtsEngine();
  const core = new FakeCoreClient();
  const orchestrator = createVoiceOrchestrator(
    { wakeWord: wake, stt, tts, core },
    {
      minCharsPerChunk: 1,
      silenceThresholdMs: 50,
      forceEndMs: 400,
      bargeInDebounceMs: 0,
      ...config,
    },
  );
  const events: OrchestratorEvent[] = [];
  orchestrator.on((e) => events.push(e));
  return { wake, stt, tts, core, orchestrator, events };
}

describe("confirmed barge-in (default)", () => {
  it("drops an echo final during speaking — reply completes uncut", async () => {
    const { wake, stt, tts, core, orchestrator, events } = setup();
    core.tokenScript = FIVE_SENTENCE_TOKENS;
    tts.msPerSentence = 100; // ~500ms of speaking
    stt.holdOpenAfterScript = true;
    stt.setScript(userSpeech("Count to five slowly."));

    // Echo of Jarvis's own audio comes back through the open mic mid-reply.
    // Echo lags playback, so push it once the third sentence reaches TTS —
    // by then "one two three" has certainly been spoken AND streamed.
    const unsubscribe = orchestrator.on((e) => {
      if (e.type === "sentence" && e.text.includes("Three.")) {
        unsubscribe();
        stt.push({ type: "speech_start" });
        stt.push({ type: "speech_end", silenceMs: 900 });
        stt.push({ type: "final", text: "one two three", confidence: 0.9 });
      }
    });

    orchestrator.start();
    wake.fire({ id: "s1" });

    const turn = await waitFor(events, (e) => e.type === "turn_complete");
    const cancelsBeforeStop = tts.cancelCount;
    await orchestrator.stop();

    expect(cancelsBeforeStop).toBe(0);
    expect(events.some((e) => e.type === "barge_in")).toBe(false);
    expect(core.chatCalls).toEqual(["Count to five slowly."]);
    if (turn.type === "turn_complete") {
      expect(turn.turn.bargedIn).toBe(false);
      expect(turn.turn.assistantText).toContain("Five.");
    }
  });

  it("a genuine final during speaking confirms barge-in and starts the next turn", async () => {
    const { wake, stt, tts, core, orchestrator, events } = setup();
    core.tokenScript = FIVE_SENTENCE_TOKENS;
    tts.msPerSentence = 100;
    stt.holdOpenAfterScript = true;
    stt.setScript(userSpeech("Count to five slowly."));

    onceState(orchestrator, "speaking", () => {
      stt.push({ type: "speech_start" });
      stt.push({ type: "speech_end", silenceMs: 900 });
      stt.push({
        type: "final",
        text: "Stop, please tell me a joke instead.",
        confidence: 0.9,
      });
    });

    orchestrator.start();
    wake.fire({ id: "s2" });

    await waitFor(events, (e) => e.type === "barge_in");
    const turn = await waitFor(
      events,
      (e) =>
        e.type === "turn_complete" &&
        e.turn.userText === "Stop, please tell me a joke instead.",
    );
    await orchestrator.stop();

    expect(tts.cancelCount).toBeGreaterThanOrEqual(1);
    expect(core.chatCalls).toEqual([
      "Count to five slowly.",
      "Stop, please tell me a joke instead.",
    ]);
    expect(turn.type).toBe("turn_complete");
  });

  it("drops a trailing echo in the next session (wake right after a reply)", async () => {
    const { wake, stt, core, orchestrator, events } = setup();
    core.tokenScript = ["You have three ", "meetings tomorrow."];
    stt.holdOpenAfterScript = true;
    stt.setScript(userSpeech("What's on my calendar?"));
    orchestrator.start();
    wake.fire({ id: "s3" });

    await waitFor(events, (e) => e.type === "turn_complete");
    await waitFor(events, (e) => e.type === "state_change" && e.state === "idle");

    // User wakes Jarvis again immediately; the mic catches the tail of the
    // previous reply (VAD hangover + Whisper lag put it ~1s behind playback).
    stt.setScript([]);
    wake.fire({ id: "s3b" });
    await waitFor(
      events,
      (e) => e.type === "state_change" && e.state === "listening" &&
        events.filter((x) => x.type === "state_change" && x.state === "listening").length >= 2,
    );
    stt.push({ type: "speech_start" });
    stt.push({ type: "speech_end", silenceMs: 900 });
    stt.push({
      type: "final",
      text: "you have three meetings tomorrow",
      confidence: 0.9,
    });
    // Then the user actually speaks:
    stt.push({ type: "speech_start" });
    stt.push({ type: "speech_end", silenceMs: 900 });
    stt.push({ type: "final", text: "What time is it?", confidence: 0.95 });

    await waitFor(
      events,
      (e) => e.type === "turn_complete" && e.turn.userText === "What time is it?",
    );
    await orchestrator.stop();

    expect(core.chatCalls).toEqual(["What's on my calendar?", "What time is it?"]);
  });
});

describe("immediate barge-in (opt-in legacy mode)", () => {
  it("speech_start alone cancels TTS during speaking", async () => {
    const { wake, stt, tts, core, orchestrator, events } = setup({
      bargeInMode: "immediate",
    });
    core.tokenScript = FIVE_SENTENCE_TOKENS;
    tts.msPerSentence = 100;
    stt.holdOpenAfterScript = true;
    stt.setScript(userSpeech("Talk to me."));

    onceState(orchestrator, "speaking", () => {
      stt.push({ type: "speech_start" });
    });

    orchestrator.start();
    wake.fire({ id: "s4" });

    await waitFor(events, (e) => e.type === "barge_in");
    await orchestrator.stop();
    expect(tts.cancelCount).toBeGreaterThanOrEqual(1);
  });
});
