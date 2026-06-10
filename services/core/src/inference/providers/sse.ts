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
 */

interface OpenAiChunkChoiceDelta {
  content?: string | null;
}
interface OpenAiChunkChoice {
  delta?: OpenAiChunkChoiceDelta;
  finish_reason?: string | null;
}
interface OpenAiChunk {
  choices?: OpenAiChunkChoice[];
}

/**
 * Parse an OpenAI-compatible SSE stream from a fetch Response and yield text
 * deltas. Throws if the response has no readable body.
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
      if (signal?.aborted) break;
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
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            yield delta;
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
