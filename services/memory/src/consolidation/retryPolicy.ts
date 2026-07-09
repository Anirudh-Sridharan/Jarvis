/**
 * MEM-02: pure, Clock-driven backoff/dead-letter policy for consolidation
 * retries.
 *
 * No sleeping, no pseudo-random generator, no side effects — every function here takes
 * `nowMs` as an argument so callers (ConsolidationService, tests) control time
 * deterministically via an injected Clock. Retries span multiple SCHEDULED
 * consolidation passes (minutes apart), not a single in-process retry loop —
 * see services/integrations/src/framework/backoff.ts for the (deliberately
 * NOT reused here) setTimeout-based sub-second HTTP retry shape.
 *
 * Jitter is deterministic and hash-derived (mirrors
 * services/integrations/src/framework/scheduler.ts's sourceJitter()) so
 * retry-eligibility tests stay hermetic and reproducible: the same record id
 * always produces the same jitter offset.
 */

import { createHash } from "node:crypto";

/** Base delay before the first retry: 5 minutes. */
const BASE_MS = 5 * 60_000;
/** Exponential backoff multiplier applied per additional failed attempt. */
const MULTIPLIER = 3;
/** Hard ceiling on any single retry delay: 6 hours. */
const MAX_MS = 6 * 60 * 60_000;
/** Fraction of the (capped) base delay used as the deterministic jitter window. */
const JITTER_FRACTION = 0.2;
/** Number of failed extraction attempts after which a record is dead-lettered. */
export const DEAD_LETTER_THRESHOLD = 5;

/**
 * Deterministic per-record jitter in [0, maxMs). Hash-derived (sha256 of
 * recordId, first two bytes → [0,1)) — same recordId always yields the same
 * value, so retry tests never need a pseudo-random generator or fake timers.
 */
export function recordJitter(recordId: string, maxMs: number): number {
  if (maxMs <= 0) return 0;
  const hash = createHash("sha256").update(recordId).digest();
  const byte0 = hash[0] ?? 0;
  const byte1 = hash[1] ?? 0;
  const val = (byte0 * 256 + byte1) / 65535;
  return Math.floor(val * maxMs);
}

/**
 * Whether a record with the given `next_retry_at` is eligible for retry now.
 * `null` means "never scheduled for backoff" → always eligible.
 */
export function isRetryEligible(nextRetryAt: number | null, nowMs: number): boolean {
  return nextRetryAt === null || nextRetryAt <= nowMs;
}

/**
 * Compute the next retry timestamp (unix ms) for a record after a failed
 * extraction attempt. `attempts` is the 1-indexed count of attempts INCLUDING
 * the one that just failed. Clamped to >= 1 so a corrupted zero/negative
 * `consolidation_attempts` row can never invert the exponent into a
 * near-zero or negative delay (T-08-02).
 */
export function computeNextRetryAt(
  recordId: string,
  attempts: number,
  nowMs: number,
): number {
  const safeAttempts = Math.max(1, attempts);
  const rawBase = BASE_MS * MULTIPLIER ** (safeAttempts - 1);
  const cappedBase = Math.min(rawBase, MAX_MS);
  const jitterMax = cappedBase * JITTER_FRACTION;
  const jitter = recordJitter(recordId, jitterMax);
  const delay = Math.min(cappedBase + jitter, MAX_MS);
  return nowMs + delay;
}
