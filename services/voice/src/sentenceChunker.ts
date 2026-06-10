/**
 * SentenceChunker (feature 7 — deterministic layer).
 *
 * Consumes an async iterable of raw LLM token strings and yields complete
 * SENTENCES as early as possible, so TTS can start before the LLM finishes.
 *
 * Rules (from spec):
 *  1. Flush at a sentence terminator (. ! ? … or newline) when buffer ≥ minChars.
 *     For the FIRST chunk, relax minChars to 1 so audio starts ASAP.
 *  2. Flush when buffer ≥ maxChars (no terminator found — long clause).
 *  3. Flush whatever remains when the token stream ends.
 *
 * The chunker is a pure async generator: given tokens → yields sentences.
 * No I/O; trivially testable.
 */

export interface ChunkerConfig {
  /** Minimum chars before flushing on a sentence terminator. Default 12. */
  minChars?: number;
  /** Max buffer before forced flush (no terminator). Default 200. */
  maxChars?: number;
}

// Matches a sentence terminator followed by whitespace or end-of-string,
// or a newline. We match the full terminator including trailing space.
// We use a global regex and scan with findAll to locate the rightmost match.
const TERMINATOR_RE = /[.!?…](?=\s|$)|\n/g;

/** Find all terminator positions in `text`. Returns array of end-indices. */
function findTerminators(text: string): number[] {
  const positions: number[] = [];
  TERMINATOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINATOR_RE.exec(text)) !== null) {
    positions.push(m.index + m[0].length);
  }
  return positions;
}

/**
 * Given a stream of token strings, yield complete sentences.
 *
 * Usage:
 *   for await (const sentence of chunkSentences(tokenStream, { minChars: 12 })) {
 *     await tts.speak(sentence);
 *   }
 */
export async function* chunkSentences(
  tokens: AsyncIterable<string>,
  config: ChunkerConfig = {},
): AsyncGenerator<string, void, unknown> {
  const minChars = config.minChars ?? 12;
  const maxChars = config.maxChars ?? 200;

  let buf = "";
  let isFirst = true;

  for await (const token of tokens) {
    buf += token;

    // Check for terminator flush
    const positions = findTerminators(buf);
    if (positions.length > 0) {
      // Use the RIGHTMOST terminator to maximise chunk size, but respect minChars.
      // Walk backwards to find the rightmost position that satisfies minChars.
      const floor = isFirst ? 1 : minChars;
      let chosen = -1;
      for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        if (pos === undefined) continue;
        const candidate = buf.slice(0, pos).trim();
        if (candidate.length >= floor) {
          chosen = pos;
          break;
        }
      }
      if (chosen > 0) {
        const sentence = buf.slice(0, chosen).trim();
        buf = buf.slice(chosen);
        if (sentence.length > 0) {
          isFirst = false;
          yield sentence;
        }
        continue;
      }
    }

    // Buffer overflow flush (no terminator found, or minChars not met)
    if (buf.length >= maxChars) {
      const sentence = buf.trim();
      buf = "";
      if (sentence.length > 0) {
        isFirst = false;
        yield sentence;
      }
    }
  }

  // End-of-stream: flush remainder
  const trailing = buf.trim();
  if (trailing.length > 0) {
    yield trailing;
  }
}

/**
 * Convenience: collect all sentences from a token array (for testing).
 */
export async function collectSentences(
  tokens: string[],
  config?: ChunkerConfig,
): Promise<string[]> {
  async function* makeIterable() {
    for (const t of tokens) yield t;
  }
  const sentences: string[] = [];
  for await (const s of chunkSentences(makeIterable(), config)) {
    sentences.push(s);
  }
  return sentences;
}
