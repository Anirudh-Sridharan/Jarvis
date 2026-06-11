/**
 * Echo filter (feature 7 — deterministic layer).
 *
 * The live mic stays open while Jarvis speaks and there is no acoustic echo
 * cancellation (ffmpeg/avfoundation capture has none), so Silero VAD +
 * Whisper can transcribe Jarvis's own speaker audio and feed it back as a
 * "user" utterance. The orchestrator uses isLikelyEcho to drop transcripts
 * that are mostly contained in the text Jarvis recently spoke.
 *
 * Pure functions; no I/O.
 */

/** Lowercase, strip everything but letters/digits, split into tokens. */
export function speechTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * True when `candidate` is likely an echo of `source`: at least `threshold`
 * of its tokens appear in `source` (multiset containment, order-insensitive —
 * Whisper echoes are near-verbatim but may drop or merge small words).
 */
export function isLikelyEcho(
  candidate: string,
  source: string,
  threshold = 0.8,
): boolean {
  const cand = speechTokens(candidate);
  if (cand.length === 0) return false;
  const pool = new Map<string, number>();
  for (const tok of speechTokens(source)) {
    pool.set(tok, (pool.get(tok) ?? 0) + 1);
  }
  let matched = 0;
  for (const tok of cand) {
    const n = pool.get(tok) ?? 0;
    if (n > 0) {
      matched++;
      pool.set(tok, n - 1);
    }
  }
  return matched / cand.length >= threshold;
}
