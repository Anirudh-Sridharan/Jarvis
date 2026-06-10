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
import { TurnLatencyTracker } from "./latency.js";
import { DefaultTurnDetector } from "./turnDetector.js";
import type {
  WakeWordSource,
  SttEngine,
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
    await this.deps.stt.stop();
    this.deps.tts.cancel();
    this.currentTurn?.llmAbort?.abort();
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

    // Fan-out: warm up models + start STT in parallel
    const warmupPromise = this.deps.core.warmup().catch((err: unknown) => {
      this.emit({
        type: "error",
        message: `Warmup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });

    // Transition to listening once warmup resolves (models ready)
    warmupPromise.then(() => {
      if (this.machine.state === "waking") {
        this.machine.send("MODELS_READY");
        void this.runSttLoop(event);
      }
    }).catch(() => {
      this.machine.trySend("ERROR");
      setTimeout(() => this.machine.trySend("RECOVER"), 1000);
    });
  }

  private async runSttLoop(wakeEvent: WakeEvent): Promise<void> {
    const sessionId = wakeEvent.id;
    this.turnDetector.reset();

    let transcript = "";
    // silenceMs tracks the reported silence from the STT engine (speech_end.silenceMs)
    // or accumulated wall-clock time when no speech_end has been received yet.
    let silenceStart: number | null = null;
    // The last reported silence from the STT engine (speech_end carries this).
    let reportedSilenceMs = 0;
    const eosAt: { value: number | null } = { value: null };

    try {
      for await (const event of this.deps.stt.startStream()) {
        // Handle barge-in speech_start during speaking
        if (event.type === "speech_start") {
          this.emit({ type: "partial_transcript", text: transcript });
          const handled = this.bargeIn.evaluate(
            this.machine.state,
            {
              cancelTts: () => this.deps.tts.cancel(),
              cancelLlm: () => this.currentTurn?.llmAbort?.abort(),
              transitionToListening: () => {
                this.machine.trySend("BARGE_IN");
              },
              markBargedIn: () => {
                if (this.currentTurn) this.currentTurn.bargedIn = true;
                this.emit({ type: "barge_in", ts: Date.now() });
              },
            },
            Date.now(),
          );

          if (handled.acted) {
            // Reset for new turn
            transcript = "";
            silenceStart = null;
            reportedSilenceMs = 0;
            eosAt.value = null;
            this.turnDetector.reset();
          }
          silenceStart = null;
          reportedSilenceMs = 0;
          continue;
        }

        if (event.type === "speech_end") {
          eosAt.value = Date.now();
          silenceStart = Date.now();
          // Use the silence duration reported by the STT/VAD engine; this is
          // authoritative (the fake STT uses this to drive deterministic tests).
          reportedSilenceMs = event.silenceMs;
        }

        if (event.type === "partial") {
          transcript = event.text;
          this.emit({ type: "partial_transcript", text: transcript });
        }

        if (event.type === "final") {
          transcript = event.text;
          eosAt.value = eosAt.value ?? Date.now();
          this.emit({ type: "final_transcript", text: transcript });
        }

        // Evaluate turn detection.
        // Prefer the STT-reported silenceMs (from speech_end) when available,
        // otherwise fall back to wall-clock elapsed since speech ended.
        const wallSilenceMs = silenceStart !== null ? Date.now() - silenceStart : 0;
        const silenceMsForDecision = reportedSilenceMs > 0
          ? Math.max(reportedSilenceMs, wallSilenceMs)
          : wallSilenceMs;

        const decision = this.turnDetector.evaluate({
          latestEvent: event,
          currentTranscript: transcript,
          silenceSinceLastSpeechMs: silenceMsForDecision,
        });

        if (decision.turnComplete && transcript.trim().length > 0) {
          if (eosAt.value === null) eosAt.value = Date.now();
          await this.runTurn(sessionId, transcript, eosAt.value);
          // Reset for next turn within the same session
          transcript = "";
          silenceStart = null;
          reportedSilenceMs = 0;
          eosAt.value = null;
          this.turnDetector.reset();
          // Return to listening after speaking completes
          if (this.machine.state === "idle") {
            // Session ended during turn processing
            break;
          }
          if (this.machine.state !== "listening" && this.machine.state !== "waking") {
            this.machine.trySend("MODELS_READY");
          }
        }
      }
    } catch (err) {
      this.emit({
        type: "error",
        message: `STT error: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.machine.trySend("ERROR");
      setTimeout(() => this.machine.trySend("RECOVER"), 1000);
    }
  }

  private async runTurn(
    sessionId: string,
    userText: string,
    eosAt: number,
  ): Promise<void> {
    const turnId = randomUUID();
    const latency = new TurnLatencyTracker(turnId);
    latency.markEos(eosAt);

    this.machine.trySend("TURN_COMPLETE");

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
      this.machine.trySend("ERROR");
      setTimeout(() => this.machine.trySend("RECOVER"), 1000);
    } finally {
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
