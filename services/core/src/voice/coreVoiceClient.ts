/**
 * CoreHttpClient — real CoreClient for the voice loop.
 *
 * warmup()    → POST /warmup (pre-loads the local MLX chat model on wake).
 * chatStream  → POST /chat, parsing the SSE token stream.
 *
 * Conversation continuity: the orchestrator passes its own voice sessionId as
 * `conversationId`, but the server mints its own conversation ids. We map
 * voice-session → server-conversation on the first turn (captured from the
 * SSE `done` frame) and reuse it for subsequent turns of the same session, so
 * a multi-turn voice session shares one conversation (and its memory).
 */

import type { CoreClient, WarmupResult } from "@jarvis/voice";

interface SseFrame {
  type?: string;
  state?: string;
  text?: string;
  conversationId?: string;
  message?: string;
}

export class CoreHttpClient implements CoreClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sessionConversations = new Map<string, string>();

  constructor(
    private readonly coreUrl: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async warmup(): Promise<WarmupResult> {
    const res = await this.fetchImpl(`${this.coreUrl}/warmup`, { method: "POST" });
    if (!res.ok) {
      return { ok: false, state: `http_${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      state?: string;
      modelId?: string;
    };
    return { ok: true, state: body.state ?? "unknown", modelId: body.modelId };
  }

  async *chatStream(
    message: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    // conversationId from the orchestrator is the VOICE session id — translate
    // to the server-side conversation id if this session already has one.
    const sessionKey = conversationId;
    const serverConversationId = sessionKey
      ? this.sessionConversations.get(sessionKey)
      : undefined;

    const res = await this.fetchImpl(`${this.coreUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        ...(serverConversationId ? { conversationId: serverConversationId } : {}),
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`core /chat failed: HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawFrame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          for (const line of rawFrame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let frame: SseFrame;
            try {
              frame = JSON.parse(line.slice(5).trim()) as SseFrame;
            } catch {
              continue;
            }

            if (frame.conversationId && sessionKey) {
              this.sessionConversations.set(sessionKey, frame.conversationId);
            }

            if (frame.type === "token" && frame.text) {
              yield frame.text;
            } else if (frame.type === "done") {
              return;
            } else if (frame.type === "error") {
              throw new Error(frame.message ?? "core chat stream error");
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
