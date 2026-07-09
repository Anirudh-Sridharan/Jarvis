/**
 * Reply-rate circuit breaker (TXT-04 hard ceiling).
 *
 * Anti-pattern this avoids: a breaker that resets its counter the instant one
 * reply succeeds (or trips only after N *consecutive failures*) provides no
 * protection against a slow-burn self-reinforcing loop where every reply
 * individually "succeeds" (Jarvis replies, its own reply gets echoed back,
 * Jarvis replies again, ad infinitum). This channel's failure mode is a loop
 * of SUCCESSFUL sends, not failing ones — so this breaker windows on reply
 * COUNT within a rolling time span per chat, and once tripped it LATCHES
 * open: isOpen() never auto-closes with the passage of time, only an
 * explicit reset() clears it. Mirrors the shape (exported UPPER_SNAKE_CASE
 * ceiling constant + Clock-injected guard), not the trigger condition, of
 * @jarvis/agent's MAX_STEPS/MAX_VALIDATION_RETRIES guards.
 */

import type { Clock } from "./types.js";

/** Default rolling window size for the reply-rate check: 60 seconds. */
export const DEFAULT_BREAKER_WINDOW_MS = 60_000;

/** Default max replies to a single chat allowed within the window. */
export const DEFAULT_BREAKER_MAX_REPLIES = 5;

export interface ReplyCircuitBreakerOptions {
  windowMs?: number;
  maxReplies?: number;
}

export class ReplyCircuitBreaker {
  private readonly windowMs: number;
  private readonly maxReplies: number;
  private readonly history = new Map<string, number[]>();
  private tripped = false;

  constructor(
    private readonly clock: Clock,
    opts?: ReplyCircuitBreakerOptions,
  ) {
    this.windowMs = opts?.windowMs ?? DEFAULT_BREAKER_WINDOW_MS;
    this.maxReplies = opts?.maxReplies ?? DEFAULT_BREAKER_MAX_REPLIES;
  }

  /**
   * Record a reply sent to `chatId`. Prunes timestamps older than the
   * rolling window, then latches the breaker open when the pruned per-chat
   * count exceeds maxReplies.
   */
  recordReply(chatId: string): void {
    const now = this.clock.now();
    const cutoff = now - this.windowMs;
    const existing = this.history.get(chatId) ?? [];
    const pruned = existing.filter((ts) => ts >= cutoff);
    pruned.push(now);
    this.history.set(chatId, pruned);

    if (pruned.length > this.maxReplies) {
      this.tripped = true;
    }
  }

  /**
   * True once latched open. NEVER time-based auto-close — the locked
   * decision is trips-open-requires-explicit-reset.
   */
  isOpen(): boolean {
    return this.tripped;
  }

  /** Close the breaker and clear all per-chat history. */
  reset(): void {
    this.tripped = false;
    this.history.clear();
  }
}
