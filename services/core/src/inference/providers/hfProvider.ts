/**
 * HF provider (feature 1): talks to a Hugging Face dedicated Inference Endpoint
 * (TGI), which exposes an OpenAI-compatible /v1/chat/completions.
 *
 * Auth: Authorization: Bearer ${HF_TOKEN}. The endpoint URL comes from
 * HF_ENDPOINT_URL (config/models.yaml entry's endpointUrl is expanded from it).
 */
import { parseOpenAiSse } from "./sse.js";
import type { ChatProvider, DispatchOptions } from "../types.js";

export class HfProvider implements ChatProvider {
  constructor(
    private readonly endpointUrl: string,
    private readonly token: string | undefined,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /** Endpoint URL may or may not already include /v1/chat/completions. */
  private chatUrl(): string {
    if (this.endpointUrl.includes("/v1/chat/completions")) return this.endpointUrl;
    return new URL("/v1/chat/completions", this.endpointUrl).toString();
  }

  async *streamChat(opts: DispatchOptions): AsyncGenerator<string, void, unknown> {
    if (!this.endpointUrl) {
      throw new Error(
        "HF endpoint not configured (set HF_ENDPOINT_URL). Cannot route this request to cloud.",
      );
    }
    const res = await fetch(this.chatUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.modelRef,
        messages: opts.messages,
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HF endpoint /v1/chat/completions failed (${res.status}): ${text}`,
      );
    }
    yield* parseOpenAiSse(res, opts.signal);
  }
}
