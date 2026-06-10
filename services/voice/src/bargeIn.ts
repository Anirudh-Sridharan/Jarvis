/**
 * Barge-in policy (feature 7 — deterministic layer).
 *
 * When the user speaks while Jarvis is talking (state === 'speaking'),
 * we must:
 *   1. Cancel in-flight TTS synthesis.
 *   2. Optionally cancel the in-flight LLM stream (configurable).
 *   3. Transition the state machine back to 'listening'.
 *   4. Mark the prior turn as bargedIn = true.
 *
 * A debounce window suppresses barge-in within the first N ms of speaking
 * to avoid the TTS's own audio (echo) tripping VAD.
 *
 * This module is a pure policy layer with injected side-effect hooks so it
 * can be tested without any audio or LLM dependencies.
 */

export interface BargeInConfig {
  /**
   * Ignore barge-in events fired within this many ms after speaking started.
   * Default 150ms — avoids TTS echo tripping VAD.
   */
  debounceMs?: number;
  /**
   * Whether to abort the in-flight LLM SSE stream on barge-in.
   * Default true (saves tokens + network; context is preserved in history).
   */
  cancelLlm?: boolean;
}

export interface BargeInHooks {
  /** Cancel TTS synthesis and flush audio buffer. */
  cancelTts: () => void;
  /** Abort the in-flight LLM request (e.g. call AbortController.abort()). */
  cancelLlm: () => void;
  /** Transition the session state machine (call machine.send('BARGE_IN')). */
  transitionToListening: () => void;
  /** Mark the current turn as interrupted. */
  markBargedIn: () => void;
}

export interface BargeInDecision {
  acted: boolean;
  reason: "debounce" | "wrong_state" | "acted";
}

export class BargeInPolicy {
  private readonly debounceMs: number;
  private readonly shouldCancelLlm: boolean;
  private speakingStartedAt: number | null = null;

  constructor(config: BargeInConfig = {}) {
    this.debounceMs = config.debounceMs ?? 150;
    this.shouldCancelLlm = config.cancelLlm ?? true;
  }

  /**
   * Notify the policy that speaking has started (resets debounce window).
   */
  onSpeakingStarted(ts: number = Date.now()): void {
    this.speakingStartedAt = ts;
  }

  /**
   * Notify the policy that speaking has stopped or been cancelled.
   */
  onSpeakingStopped(): void {
    this.speakingStartedAt = null;
  }

  /**
   * Evaluate a potential barge-in event.
   *
   * @param currentState - The current VoiceSessionState.
   * @param hooks - Side-effect callbacks to execute if barge-in is confirmed.
   * @param eventTs - Timestamp of the speech_start event (default Date.now()).
   */
  evaluate(
    currentState: string,
    hooks: BargeInHooks,
    eventTs: number = Date.now(),
  ): BargeInDecision {
    // Only act during 'speaking' (or 'thinking' where we allow early barge-in)
    if (currentState !== "speaking" && currentState !== "thinking") {
      return { acted: false, reason: "wrong_state" };
    }

    // Debounce: ignore if within debounceMs of speaking start
    if (
      this.speakingStartedAt !== null &&
      eventTs - this.speakingStartedAt < this.debounceMs
    ) {
      return { acted: false, reason: "debounce" };
    }

    // Confirmed barge-in — execute side effects
    hooks.cancelTts();
    if (this.shouldCancelLlm) {
      hooks.cancelLlm();
    }
    hooks.transitionToListening();
    hooks.markBargedIn();

    this.speakingStartedAt = null;
    return { acted: true, reason: "acted" };
  }

  /**
   * Pure function version — returns the decision without executing hooks.
   * Used in tests to verify the policy logic independently of side effects.
   */
  shouldActOn(
    currentState: string,
    eventTs: number,
    speakingStartedAt: number | null,
  ): BargeInDecision {
    if (currentState !== "speaking" && currentState !== "thinking") {
      return { acted: false, reason: "wrong_state" };
    }
    if (
      speakingStartedAt !== null &&
      eventTs - speakingStartedAt < this.debounceMs
    ) {
      return { acted: false, reason: "debounce" };
    }
    return { acted: true, reason: "acted" };
  }
}
