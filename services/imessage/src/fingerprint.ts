/**
 * Sent-message fingerprint (TXT-04 secondary loop-prevention net).
 *
 * WHY this exists: in a self-chat/Note-to-Self thread — this milestone's
 * chosen conversation surface — chat.db's is_from_me column is 1 on BOTH
 * sides of the conversation. There is no sender/recipient asymmetry to filter
 * on inside that thread, so a design that trusts is_from_me as the sole
 * loop-prevention signal will free-run exactly in the conversation surface
 * this milestone requires. This exact-content-plus-recency check is the
 * load-bearing echo guard for that case, not merely a defensive extra.
 *
 * Recency (TTL) lives in the store query (ImessageStateStore), not here —
 * these are pure functions with no I/O and no Clock.
 */

import { createHash } from "node:crypto";

/**
 * Lowercase, strip everything but unicode letters/digits, collapse
 * whitespace runs to a single space, and trim. "Buy MILK!!" and "buy milk"
 * normalize identically; punctuation-only input normalizes to "".
 */
export function normalizeMessageText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic sha256 hex fingerprint of a (chatId, text) pair. Text is
 * normalized before hashing so casing/punctuation/whitespace variants of the
 * same message in the same chat produce the identical fingerprint. Different
 * chatIds with identical text produce different fingerprints.
 */
export function computeFingerprint(chatId: string, text: string): string {
  const normalized = normalizeMessageText(text);
  return createHash("sha256").update(`${chatId}\n${normalized}`).digest("hex");
}

/** Default TTL for recorded sent-message fingerprints: 10 minutes. */
export const DEFAULT_FINGERPRINT_TTL_MS = 10 * 60_000;
