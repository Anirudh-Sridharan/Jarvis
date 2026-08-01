/**
 * Shared SSE parsing for OpenAI-compatible streaming responses.
 *
 * OpenAI/TGI/MLX servers stream `text/event-stream` where each event is:
 *   data: {...json chat.completion.chunk...}\n\n
 * terminated by:
 *   data: [DONE]\n\n
 *
 * This reads a fetch Response body and yields the decoded content deltas
 * (the `choices[0].delta.content` fragments).
 *
 * Failure semantics (WR-05): a bad stream must NEVER end "cleanly" —
 * callers accumulate deltas and treat generator completion as a successful
 * response, so this parser THROWS on:
 *   - a mid-stream `data: {"error": {...}}` event (OpenAI-compatible
 *     providers, Fireworks included, emit these on backend failure);
 *   - `finish_reason: "length"` (output clipped by max_tokens — silently
 *     returning the truncated accumulation surfaces later as an inscrutable
 *     downstream parse failure) and `finish_reason: "error"` (the MLX
 *     sidecar's mid-generation failure marker);
 *   - an abort observed between reads (e.g. GatewayLlm's
 *     AbortSignal.timeout) — previously a clean `break` reported a timed-out
 *     call's partial accumulation as a completed response.
 */

/** Mid-stream error payloads are truncated to this many chars before being embedded in a thrown Error. */
const MAX_STREAM_ERROR_CHARS = 500;

interface OpenAiChunkChoiceDelta {
  content?: string | null;
}
interface OpenAiChunkChoice {
  delta?: OpenAiChunkChoiceDelta;
  finish_reason?: string | null;
}
interface OpenAiChunk {
  choices?: OpenAiChunkChoice[];
  /** Mid-stream error event — `data: {"error": {...}}`. */
  error?: unknown;
}

function streamErrorMessage(err: unknown): string {
  let raw: string;
  if (typeof err === "object" && err !== null && "message" in err) {
    raw = String((err as { message: unknown }).message);
  } else {
    try {
      raw = JSON.stringify(err) ?? String(err);
    } catch {
      raw = String(err);
    }
  }
  return raw.length > MAX_STREAM_ERROR_CHARS ? raw.slice(0, MAX_STREAM_ERROR_CHARS) : raw;
}

/**
 * Parse an OpenAI-compatible SSE stream from a fetch Response and yield text
 * deltas. Throws if the response has no readable body, on mid-stream provider
 * errors, on truncated output, and on abort — see module doc.
 */
export async function* parseOpenAiSse(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const body = res.body;
  if (!body) {
    throw new Error("Streaming response had no body");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) {
        // A between-read abort must not end the stream cleanly (WR-05): the
        // caller would mistake the partial accumulation for a completed
        // response. Propagate the abort reason (TimeoutError for
        // AbortSignal.timeout) so timeouts reject instead of "succeeding".
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on event boundaries (blank line).
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice("data:".length).trim();
          if (data === "" ) continue;
          if (data === "[DONE]") return;
          let chunk: OpenAiChunk;
          try {
            chunk = JSON.parse(data) as OpenAiChunk;
          } catch {
            // Malformed chunk — skip rather than abort the whole stream.
            continue;
          }
          if (chunk.error != null) {
            throw new Error(`Provider stream error: ${streamErrorMessage(chunk.error)}`);
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            yield delta;
          }
          const finish = choice?.finish_reason;
          if (finish === "length") {
            throw new Error(
              'Provider stream truncated: finish_reason="length" (output clipped by max_tokens)',
            );
          }
          if (finish === "error") {
            throw new Error('Provider stream failed: finish_reason="error"');
          }
        }
      }
    }
  } finally {
    // Releasing the lock cancels the underlying stream when the consumer stops.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
