/**
 * Injected interface definitions for the @jarvis/voice package.
 *
 * These are the boundaries between the deterministic TS orchestration and the
 * Python audio sidecar. The orchestration never calls audio models directly —
 * it receives these interfaces at construction time. Real implementations are
 * thin HTTP/WS clients; test doubles are fakes in src/testing/fakes.ts.
 */

// ---------------------------------------------------------------------------
// Wake Word
// ---------------------------------------------------------------------------

/** A confirmed wake-word detection event. */
export interface WakeEvent {
  id: string;
  source: "wakeword" | "ptt";
  phrase: "Hey Jarvis";
  confidence: number; // 0..1 ; 1.0 for PTT
  timestamp: number; // epoch ms
  deviceId: string;
  warmTriggered: boolean;
}

/** Source that emits wake-word events. Register a listener with `onWake`. */
export interface WakeWordSource {
  /** Register a listener — called for each confirmed wake event. */
  onWake(listener: (event: WakeEvent) => void): () => void; // returns unsubscribe
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

/** A single event emitted by the STT engine during streaming. */
export type SttEvent =
  | { type: "partial"; text: string; stability: number }
  | { type: "final"; text: string; confidence: number }
  | { type: "speech_start" }
  | { type: "speech_end"; silenceMs: number };

/** Streaming speech-to-text engine with embedded VAD events. */
export interface SttEngine {
  /**
   * Begin a streaming STT session. Returns an async iterable of SttEvents.
   * Ends when `stop()` is called or the session is finalized.
   */
  startStream(): AsyncIterable<SttEvent>;
  /** Finalize and close the stream. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Turn Detector
// ---------------------------------------------------------------------------

export interface TurnDetectorInput {
  latestEvent: SttEvent;
  currentTranscript: string;
  silenceSinceLastSpeechMs: number;
}

export interface TurnDetectorOutput {
  turnComplete: boolean;
  reason: "semantic" | "silence" | "ptt_release" | "timeout";
}

/**
 * Decides whether the user's turn is finished.
 *
 * The default `DefaultTurnDetector` is deterministic:
 *   • Turn ends when `speech_end` + silence ≥ `silenceThresholdMs`
 *     AND (transcript ends with sentence punctuation OR silence > `forceEndMs`).
 *
 * Pluggable so a semantic Smart-Turn model can be injected for Phase 2.
 */
export interface TurnDetector {
  evaluate(input: TurnDetectorInput): TurnDetectorOutput;
  reset(): void;
}

export interface TurnDetectorConfig {
  /** Silence after speech_end to wait before ending the turn. Default 800ms. */
  silenceThresholdMs?: number;
  /** Force end-of-turn even without punctuation after this silence. Default 2000ms. */
  forceEndMs?: number;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TtsEngine {
  /**
   * Speak the sentences from the async iterable. Each sentence is synthesized
   * and played as soon as it arrives. Returns when all audio has been played
   * (or cancelled).
   */
  speak(sentences: AsyncIterable<string>, signal?: AbortSignal): Promise<void>;
  /** Immediately cancel ongoing synthesis and flush the audio buffer. */
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Core Client
// ---------------------------------------------------------------------------

export interface WarmupResult {
  ok: boolean;
  state: string;
  modelId?: string;
}

export interface CoreClient {
  /** POST /warmup — fire-and-forget model pre-load. */
  warmup(): Promise<WarmupResult>;
  /**
   * POST /chat — returns an async iterable of token strings.
   * Consumes core's SSE `data: { type: "token", text }` frames.
   * Ends on `{ type: "done" }` or stream close.
   */
  chatStream(
    message: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/** A single completed voice turn. */
export interface VoiceTurn {
  id: string;
  sessionId: string;
  startedAt: number; // epoch ms, end-of-user-speech
  userText: string;
  assistantText: string;
  bargedIn: boolean;
  timings: TurnTimings;
}

export interface TurnTimings {
  eosToSttFinalMs: number;
  sttFinalToTtftMs: number;
  ttftToFirstAudioMs: number;
  eosToFirstAudioMs: number;
  totalTurnMs: number;
}
