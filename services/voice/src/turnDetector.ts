/**
 * Default deterministic TurnDetector implementation.
 *
 * End-of-turn when:
 *   1. speech_end event received, AND
 *   2. silence ≥ silenceThresholdMs (default 800ms), AND
 *   3. transcript ends with sentence punctuation OR silence > forceEndMs.
 *
 * Smart-Turn (semantic) model can replace this by injecting a different
 * TurnDetector implementation.
 */

import type {
  TurnDetector,
  TurnDetectorConfig,
  TurnDetectorInput,
  TurnDetectorOutput,
} from "./interfaces.js";

const SENTENCE_TERMINAL_RE = /[.!?…]\s*$/;

export class DefaultTurnDetector implements TurnDetector {
  private readonly silenceThresholdMs: number;
  private readonly forceEndMs: number;
  private inSpeech = false;
  private speechEndedAt: number | null = null;

  constructor(config: TurnDetectorConfig = {}) {
    this.silenceThresholdMs = config.silenceThresholdMs ?? 800;
    this.forceEndMs = config.forceEndMs ?? 2000;
  }

  evaluate(input: TurnDetectorInput): TurnDetectorOutput {
    const { latestEvent, currentTranscript, silenceSinceLastSpeechMs } = input;

    if (latestEvent.type === "speech_start") {
      this.inSpeech = true;
      this.speechEndedAt = null;
      return { turnComplete: false, reason: "silence" };
    }

    if (latestEvent.type === "speech_end") {
      this.inSpeech = false;
      this.speechEndedAt = Date.now();
    }

    // Must have seen speech_end before making a turn-complete decision
    if (this.inSpeech || this.speechEndedAt === null) {
      return { turnComplete: false, reason: "silence" };
    }

    const endsWithPunctuation = SENTENCE_TERMINAL_RE.test(currentTranscript);

    // Force end on long silence regardless of punctuation
    if (silenceSinceLastSpeechMs >= this.forceEndMs) {
      return { turnComplete: true, reason: "silence" };
    }

    // Normal end: sufficient silence + punctuation
    if (
      silenceSinceLastSpeechMs >= this.silenceThresholdMs &&
      endsWithPunctuation
    ) {
      return { turnComplete: true, reason: "semantic" };
    }

    return { turnComplete: false, reason: "silence" };
  }

  reset(): void {
    this.inSpeech = false;
    this.speechEndedAt = null;
  }
}
