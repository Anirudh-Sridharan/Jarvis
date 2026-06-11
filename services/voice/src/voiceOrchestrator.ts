/**
 * VoiceOrchestrator — wires the full pipeline with injected dependencies.
 *
 * Flow:
 *   WakeWordSource.onWake() → CoreClient.warmup() + SttEngine.startStream()
 *   → TurnDetector decides end-of-turn
 *   → CoreClient.chatStream() → sentenceChunker → TtsEngine.speak()
 *   → bargeIn (speech_start during speaking) → cancel TTS + LLM + →listening
 *   → TurnLatencyTracker records per-stage timestamps
 *
 * All dependencies are injected so the orchestrator is fully testable with fakes.
 */

import { chunkSentences } from "./sentenceChunker.js";
import { SessionMachine } from "./sessionMachine.js";
import { BargeInPolicy } from "./bargeIn.js";
import { isLikelyEcho } from "./echoFilter.js";
import { TurnLatencyTracker } from "./latency.js";
import { DefaultTurnDetector } from "./turnDetector.js";
import type {
  WakeWordSource,
  SttEngine,
  SttEvent,
  TtsEngine,
  CoreClient,
  TurnDetector,
  VoiceTurn,
  WakeEvent,
} from "./interfaces.js";
import { randomUUID } from "node:crypto";

export interface OrchestratorConfig {
  /** Minimum chars for sentence chunker. Default 12. */
  minCharsPerChunk?: number;
  /** Maximum chars for sentence chunker. Default 200. */
  maxCharsPerChunk?: number;
  /** Barge-in debounce window. Default 150ms. */
  bargeInDebounceMs?: number;
  /** Whether to cancel LLM stream on barge-in. Default true. */
  cancelLlmOnBargeIn?: boolean;
  /** Silence threshold for turn detection. Default 800ms. */
  silenceThresholdMs?: number;
  /** Force-end silence. Default 2000ms. */
  forceEndMs?: number;
  /**
   * Barge-in mode. "confirmed" (default): a speech_start during speaking does
   * NOT cancel the reply; only a final transcript that is not an echo of the
   * assistant's own recent speech confirms the barge-in. The live mic has no
   * AEC, so immediate cancellation lets Jarvis's speaker audio interrupt
   * himself. "immediate": legacy behavior — speech_start cancels at once
   * (only safe with echo-cancelled capture).
   */
  bargeInMode?: "immediate" | "confirmed";
  /** How long after a reply finishes its text still counts as echo. Default 5000ms. */
  echoGraceMs?: number;
}

export interface OrchestratorDeps {
  wakeWord: WakeWordSource;
  stt: SttEngine;
  tts: TtsEngine;
  core: CoreClient;
  /** Optional custom turn detector; defaults to DefaultTurnDetector. */
  turnDetector?: TurnDetector;
}

export type OrchestratorEvent =
  | { type: "wake"; event: WakeEvent }
  | { type: "state_change"; state: string; ts: number }
  | { type: "partial_transcript"; text: string }
  | { type: "final_transcript"; text: string }
  | { type: "token"; text: string }
  | { type: "sentence"; text: string }
  | { type: "turn_complete"; turn: VoiceTurn }
  | { type: "barge_in"; ts: number }
  | { type: "error"; message: string };

type EventListener = (event: OrchestratorEvent) => void;

export class VoiceOrchestrator {
  private readonly machine: SessionMachine;
  private readonly bargeIn: BargeInPolicy;
  private readonly turnDetector: TurnDetector;
  private readonly config: Required<OrchestratorConfig>;
  private listeners: EventListener[] = [];
  private unsubWake: (() => void) | null = null;
  /** In-flight turn pipeline (LLM → chunker → TTS). Turns are serialized on it. */
  private inFlightTurn: Promise<void> | null = null;
  /** Re-evaluates end-of-turn when the STT engine goes quiet mid-silence. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending error → RECOVER timer. */
  private recoverTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTurn: {
    id: string;
    sessionId: string;
    startedAt: number;
    transcript: string;
    assistantText: string;
    bargedIn: boolean;
    latency: TurnLatencyTracker;
    llmAbort: AbortController | null;
    speakingStartedAt: number | null;
  } | null = null;
  /** Text of the last finished/cancelled reply, considered echo until `until`. */
  private lastAssistantSpeech: { text: string; until: number } | null = null;

  constructor(
    private readonly deps: OrchestratorDeps,
    config: OrchestratorConfig = {},
  ) {
    this.config = {
      minCharsPerChunk: config.minCharsPerChunk ?? 12,
      maxCharsPerChunk: config.maxCharsPerChunk ?? 200,
      bargeInDebounceMs: config.bargeInDebounceMs ?? 150,
      cancelLlmOnBargeIn: config.cancelLlmOnBargeIn ?? true,
      silenceThresholdMs: config.silenceThresholdMs ?? 800,
      forceEndMs: config.forceEndMs ?? 2000,
      bargeInMode: config.bargeInMode ?? "confirmed",
      echoGraceMs: config.echoGraceMs ?? 5000,
    };

    this.machine = new SessionMachine();
    this.bargeIn = new BargeInPolicy({
      debounceMs: this.config.bargeInDebounceMs,
      cancelLlm: this.config.cancelLlmOnBargeIn,
    });
    this.turnDetector =
      deps.turnDetector ??
      new DefaultTurnDetector({
        silenceThresholdMs: this.config.silenceThresholdMs,
        forceEndMs: this.config.forceEndMs,
      });

    // Forward state transitions to listeners
    this.machine.onTransition((t) => {
      this.emit({ type: "state_change", state: t.to, ts: t.ts });
    });
  }

  get state() {
    return this.machine.state;
  }

  /** Subscribe to orchestrator events. Returns unsubscribe. */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Start the orchestrator — begins listening for wake events. */
  start(): void {
    this.deps.wakeWord.start();
    this.unsubWake = this.deps.wakeWord.onWake((event) => {
      void this.handleWake(event);
    });
  }

  /** Stop the orchestrator cleanly. */
  async stop(): Promise<void> {
    if (this.unsubWake) {
      this.unsubWake();
      this.unsubWake = null;
    }
    this.deps.wakeWord.stop();
    this.clearSilenceTimer();
    this.clearRecoverTimer();
    this.currentTurn?.llmAbort?.abort();
    await this.deps.stt.stop();
    this.deps.tts.cancel();
    // Join the in-flight turn (its LLM stream was just aborted) so no pipeline
    // keeps running after stop() resolves.
    const inFlight = this.inFlightTurn;
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    this.machine.trySend("FORCE_IDLE");
  }

  // ---------------------------------------------------------------------------
  // Private orchestration
  // ---------------------------------------------------------------------------

  private async handleWake(event: WakeEvent): Promise<void> {
    // Ignore wakes during an active session (avoid double-warm)
    if (this.machine.state !== "idle") {
      return;
    }

    this.emit({ type: "wake", event });
    this.machine.send("WAKE");

    // Warm up models; only proceed to listening when warmup succeeded.
    try {
      await this.deps.core.warmup();
    } catch (err) {
      this.emit({
        type: "error",
        message: `Warmup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.enterErrorState();
      return;
    }

    // Only legal from "waking" — guards against stop()/error racing the warmup.
    if (this.machine.canSend("MODELS_READY")) {
      this.machine.send("MODELS_READY");
      void this.runSttLoop(event);
    }
  }

  /** Send ERROR and schedule recovery back to idle. */
  private enterErrorState(): void {
    this.machine.trySend("ERROR");
    this.clearRecoverTimer();
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      this.machine.trySend("RECOVER");
    }, 1000);
  }

  private clearRecoverTimer(): void {
    if (this.recoverTimer !== null) {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Side-effect hooks shared by the immediate and confirmed barge-in paths. */
  private bargeInHooks() {
    return {
      cancelTts: () => this.deps.tts.cancel(),
      cancelLlm: () => this.currentTurn?.llmAbort?.abort(),
      transitionToListening: () => {
        this.machine.trySend("BARGE_IN");
      },
      markBargedIn: () => {
        if (this.currentTurn) this.currentTurn.bargedIn = true;
        this.emit({ type: "barge_in", ts: Date.now() });
      },
    };
  }

  /** Assistant text the open mic could currently be hearing (or just heard). */
  private recentAssistantText(): string {
    const parts: string[] = [];
    if (this.currentTurn?.assistantText) parts.push(this.currentTurn.assistantText);
    if (this.lastAssistantSpeech && Date.now() <= this.lastAssistantSpeech.until) {
      parts.push(this.lastAssistantSpeech.text);
    }
    return parts.join(" ");
  }

  /** True when a transcript is likely Jarvis's own voice from the speakers. */
  private isEchoTranscript(text: string): boolean {
    if (this.config.bargeInMode !== "confirmed") return false;
    const source = this.recentAssistantText();
    if (!source) return false;
    return isLikelyEcho(text, source);
  }

  private async runSttLoop(wakeEvent: WakeEvent): Promise<void> {
    const sessionId = wakeEvent.id;
    this.turnDetector.reset();

    let transcript = "";
    // Finals already committed this turn. The STT engine emits one `final`
    // PER VAD SEGMENT (a pause longer than its silence hangover ends a
    // segment and clears its buffer) — but the turn detector may not end the
    // turn until later, so a single user turn can span several finals.
    // Overwriting instead of accumulating would discard everything said
    // before a mid-utterance pause.
    let committed = "";
    // silenceStart tracks wall-clock time since the last speech_end.
    let silenceStart: number | null = null;
    // The last reported silence from the STT engine (speech_end carries this).
    let reportedSilenceMs = 0;
    let eosAt: number | null = null;

    const resetTurnTracking = (): void => {
      transcript = "";
      committed = "";
      silenceStart = null;
      reportedSilenceMs = 0;
      eosAt = null;
      this.turnDetector.reset();
      this.clearSilenceTimer();
    };

    // Start a turn WITHOUT awaiting it, so this loop keeps consuming STT
    // events while the reply streams/plays — that is what makes barge-in
    // reachable. Turns are serialized: a new turn joins the prior in-flight
    // turn (which a barge-in has already cancelled) before running.
    const startTurn = (text: string, eos: number): void => {
      const prior = this.inFlightTurn;
      const turnPromise = (async () => {
        if (prior) await prior;
        await this.runTurn(sessionId, text, eos);
      })();
      this.inFlightTurn = turnPromise;
      void turnPromise.then(() => {
        if (this.inFlightTurn === turnPromise) this.inFlightTurn = null;
        // Session ended (REPLY_DONE → idle): close the STT stream so the
        // loop below terminates instead of lingering as an orphan.
        if (this.machine.state === "idle") {
          void this.deps.stt.stop();
        }
      });
    };

    // Evaluate end-of-turn for the latest event. Also called from the silence
    // timer when the engine goes quiet without emitting further events.
    const evaluateEndOfTurn = (latestEvent: SttEvent): void => {
      // Prefer the STT-reported silenceMs (from speech_end) when available,
      // otherwise fall back to wall-clock elapsed since speech ended.
      const wallSilenceMs = silenceStart !== null ? Date.now() - silenceStart : 0;
      const silenceMsForDecision = reportedSilenceMs > 0
        ? Math.max(reportedSilenceMs, wallSilenceMs)
        : wallSilenceMs;

      const decision = this.turnDetector.evaluate({
        latestEvent,
        currentTranscript: transcript,
        silenceSinceLastSpeechMs: silenceMsForDecision,
      });

      if (decision.turnComplete && transcript.trim().length > 0) {
        const text = transcript;
        const eos = eosAt ?? Date.now();
        resetTurnTracking();
        startTurn(text, eos);
        return;
      }

      // Not complete yet: if we are waiting out silence, arm a timer that
      // re-evaluates when the next threshold elapses. Without this, a single
      // speech_end below the threshold followed by engine quiet would never
      // complete the turn (no further events arrive to re-trigger evaluation).
      this.clearSilenceTimer();
      if (silenceStart !== null && transcript.trim().length > 0) {
        const wallNow = Date.now() - silenceStart;
        const delays = [this.config.silenceThresholdMs, this.config.forceEndMs]
          .filter((t) => silenceMsForDecision < t)
          .map((t) => t - wallNow)
          .filter((d) => d > 0);
        if (delays.length > 0) {
          this.silenceTimer = setTimeout(() => {
            this.silenceTimer = null;
            evaluateEndOfTurn(latestEvent);
          }, Math.min(...delays) + 1);
        }
      }
    };

    try {
      for await (const event of this.deps.stt.startStream()) {
        // Handle barge-in speech_start during thinking/speaking
        if (event.type === "speech_start") {
          this.clearSilenceTimer();
          this.emit({ type: "partial_transcript", text: transcript });
          // Confirmed mode does NOT cancel on raw VAD — without AEC this event
          // fires for Jarvis's own speaker audio. Cancellation waits for a
          // non-echo final (below).
          if (this.config.bargeInMode === "immediate") {
            const handled = this.bargeIn.evaluate(
              this.machine.state,
              this.bargeInHooks(),
              Date.now(),
            );
            if (handled.acted) {
              // Reset for new turn
              resetTurnTracking();
            }
          }
          silenceStart = null;
          reportedSilenceMs = 0;
          continue;
        }

        if (event.type === "speech_end") {
          eosAt = Date.now();
          silenceStart = Date.now();
          // Use the silence duration reported by the STT/VAD engine; this is
          // authoritative (the fake STT uses this to drive deterministic tests).
          reportedSilenceMs = event.silenceMs;
        }

        if (event.type === "partial") {
          if (this.isEchoTranscript(event.text)) continue;
          // Partials are cumulative within the CURRENT segment only; prepend
          // the finals already committed this turn.
          transcript = committed ? `${committed} ${event.text}` : event.text;
          this.emit({ type: "partial_transcript", text: transcript });
        }

        if (event.type === "final") {
          if (this.isEchoTranscript(event.text)) {
            // Jarvis's own audio transcribed by the open mic — not the user.
            continue;
          }
          if (this.config.bargeInMode === "confirmed") {
            const handled = this.bargeIn.evaluate(
              this.machine.state,
              this.bargeInHooks(),
              Date.now(),
            );
            if (handled.acted) {
              // Fresh turn from this utterance: drop anything captured before
              // the interruption. Do NOT reset the turn detector — it has
              // already seen this utterance's speech_end, which is what lets
              // end-of-turn fire for the interrupting speech.
              transcript = "";
              committed = "";
            }
          }
          committed = committed ? `${committed} ${event.text}` : event.text;
          transcript = committed;
          eosAt = eosAt ?? Date.now();
          this.emit({ type: "final_transcript", text: transcript });
        }

        evaluateEndOfTurn(event);
      }
    } catch (err) {
      this.emit({
        type: "error",
        message: `STT error: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.enterErrorState();
    } finally {
      this.clearSilenceTimer();
    }
  }

  private async runTurn(
    sessionId: string,
    userText: string,
    eosAt: number,
  ): Promise<void> {
    // Guard: only run when the machine can actually start a turn (listening →
    // thinking). An orphaned/queued turn after error recovery or session end
    // (machine idle) must no-op instead of driving the pipeline off-state.
    if (this.machine.trySend("TURN_COMPLETE") === null) {
      return;
    }

    const turnId = randomUUID();
    const latency = new TurnLatencyTracker(turnId);
    latency.markEos(eosAt);

    // Record STT final (we already have it)
    latency.markSttFinal(Date.now());

    const llmAbort = new AbortController();
    this.currentTurn = {
      id: turnId,
      sessionId,
      startedAt: eosAt,
      transcript: userText,
      assistantText: "",
      bargedIn: false,
      latency,
      llmAbort,
      speakingStartedAt: null,
    };

    let firstTokenSeen = false;
    const orchestrator = this;

    try {
      // Build token stream from core SSE
      const tokenStream = this.deps.core.chatStream(
        userText,
        sessionId,
        llmAbort.signal,
      );

      // Wrap to intercept first token
      async function* instrumentedTokens(): AsyncGenerator<string> {
        for await (const token of tokenStream) {
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            latency.markLlmFirstToken();
            // Transition to speaking on first token
            if (orchestrator.machine.state === "thinking") {
              orchestrator.machine.send("FIRST_TOKEN");
            }
          }
          orchestrator.emit({ type: "token", text: token });
          if (orchestrator.currentTurn) orchestrator.currentTurn.assistantText += token;
          yield token;
        }
      }

      // Pipe tokens through sentence chunker → TTS
      const sentences = chunkSentences(instrumentedTokens(), {
        minChars: orchestrator.config.minCharsPerChunk,
        maxChars: orchestrator.config.maxCharsPerChunk,
      });

      let firstSentence = true;

      async function* sentencesWithTracking(): AsyncGenerator<string> {
        for await (const sentence of sentences) {
          if (firstSentence) {
            firstSentence = false;
            latency.markFirstChunk();
            orchestrator.emit({ type: "sentence", text: sentence });
          } else {
            orchestrator.emit({ type: "sentence", text: sentence });
          }
          yield sentence;
        }
      }

      const sentenceIterable = sentencesWithTracking();

      // Track when TTS starts/stops for barge-in debounce
      if (this.currentTurn) {
        this.currentTurn.speakingStartedAt = Date.now();
        this.bargeIn.onSpeakingStarted(this.currentTurn.speakingStartedAt);
      }

      await this.deps.tts.speak(sentenceIterable, llmAbort.signal);
      latency.markFirstAudio(); // approximation — TTS engine would be more precise
      latency.markReplyDone();
      this.bargeIn.onSpeakingStopped();

      // Complete the turn
      const turn = this.buildTurn(userText);
      if (turn) {
        this.emit({ type: "turn_complete", turn });
      }

      if (
        this.machine.state === "speaking" ||
        this.machine.state === "thinking"
      ) {
        this.machine.trySend("REPLY_DONE");
      }
    } catch (err) {
      if (llmAbort.signal.aborted) {
        // Barge-in cancelled the turn — not an error
        this.bargeIn.onSpeakingStopped();
        return;
      }
      this.emit({
        type: "error",
        message: `Turn error: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.enterErrorState();
      // Tear down the STT stream: the session is over. Otherwise the loop in
      // runSttLoop stays alive as an orphan and a later wake would start a
      // SECOND concurrent stream writing shared state.
      void this.deps.stt.stop();
    } finally {
      if (this.currentTurn && this.currentTurn.assistantText.trim().length > 0) {
        // Trailing-echo guard: the mic keeps hearing this reply for a while
        // after playback (VAD hangover + Whisper lag).
        this.lastAssistantSpeech = {
          text: this.currentTurn.assistantText,
          until: Date.now() + this.config.echoGraceMs,
        };
      }
      this.currentTurn = null;
    }
  }

  private buildTurn(userText: string): VoiceTurn | null {
    if (!this.currentTurn) return null;
    const latency = this.currentTurn.latency.finish();
    return {
      id: this.currentTurn.id,
      sessionId: this.currentTurn.sessionId,
      startedAt: this.currentTurn.startedAt,
      userText,
      assistantText: this.currentTurn.assistantText,
      bargedIn: this.currentTurn.bargedIn,
      timings: {
        eosToSttFinalMs: latency.eosToSttFinalMs ?? 0,
        sttFinalToTtftMs: latency.sttFinalToTtftMs ?? 0,
        ttftToFirstAudioMs: latency.ttftToFirstAudioMs ?? 0,
        eosToFirstAudioMs: latency.eosToFirstAudioMs ?? 0,
        totalTurnMs: latency.totalTurnMs ?? 0,
      },
    };
  }

  private emit(event: OrchestratorEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // listeners must not crash the orchestrator
      }
    }
  }
}

/**
 * Factory function — the public API for creating a VoiceOrchestrator.
 */
export function createVoiceOrchestrator(
  deps: OrchestratorDeps,
  config?: OrchestratorConfig,
): VoiceOrchestrator {
  return new VoiceOrchestrator(deps, config);
}
