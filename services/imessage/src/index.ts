/**
 * @jarvis/imessage — public API
 *
 * A hermetic leaf implementing loop-prevention and restart-safe persistence
 * primitives for the (not-yet-live) iMessage texting channel. No chat.db,
 * AppleScript, or core access exists anywhere in this package — everything
 * external is an injected interface (see ./types.js), with scriptable fakes
 * exported via ./testing.
 */

// Interfaces (the injected boundary)
export type {
  Clock,
  IncomingMessage,
  MessageSource,
  MessageSender,
  ChatHandler,
} from "./types.js";

// Fingerprint (TXT-04 secondary loop-prevention net)
export {
  normalizeMessageText,
  computeFingerprint,
  DEFAULT_FINGERPRINT_TTL_MS,
} from "./fingerprint.js";

// Reply-rate circuit breaker (TXT-04 hard ceiling)
export {
  ReplyCircuitBreaker,
  DEFAULT_BREAKER_WINDOW_MS,
  DEFAULT_BREAKER_MAX_REPLIES,
} from "./circuitBreaker.js";
export type { ReplyCircuitBreakerOptions } from "./circuitBreaker.js";
