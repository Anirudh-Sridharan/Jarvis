/**
 * MLX provider (feature 1): talks to the local mlx-lm OpenAI-compatible sidecar.
 *
 * The sidecar (separate Python package) exposes:
 *   POST /v1/chat/completions   (supports stream:true SSE)
 *   POST /v1/embeddings
 *   POST /load                  lifecycle: load a model_ref into memory
 *   POST /unload                lifecycle: free weights + KV cache
 *   GET  /health                lifecycle/health probe
 *
 * The only thing that can be unavailable is the model/sidecar itself; failures
 * surface as clear errors so the gateway can fall back to HF.
 */
import { parseOpenAiSse } from "./sse.js";
import type {
  ChatProvider,
  DispatchOptions,
} from "../types.js";

export interface MlxHealth {
  ok: boolean;
  /** Model ref currently resident, if any. */
  model?: string;
}

export class MlxProvider implements ChatProvider {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  /** GET /health — true if the sidecar process answers. */
  async health(signal?: AbortSignal): Promise<MlxHealth> {
    try {
      const res = await fetch(this.url("/health"), {
        method: "GET",
        signal: signal ?? AbortSignal.timeout(2_000),
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json().catch(() => ({}))) as { model?: string };
      return { ok: true, model: body.model };
    } catch {
      return { ok: false };
    }
  }

  /** POST /load — instruct the sidecar to load model_ref into memory. */
  async load(modelRef: string, signal?: AbortSignal): Promise<void> {
    const res = await fetch(this.url("/load"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelRef }),
      // Cold start can take a few seconds; allow generous time.
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `MLX sidecar /load failed (${res.status}) for "${modelRef}": ${text}`,
      );
    }
  }

  /** POST /unload — free weights + KV cache. */
  async unload(signal?: AbortSignal): Promise<void> {
    const res = await fetch(this.url("/unload"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MLX sidecar /unload failed (${res.status}): ${text}`);
    }
  }

  /** POST /v1/chat/completions with stream:true; yields content deltas. */
  async *streamChat(opts: DispatchOptions): AsyncGenerator<string, void, unknown> {
    const res = await fetch(this.url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
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
        `MLX sidecar /v1/chat/completions failed (${res.status}): ${text}`,
      );
    }
    yield* parseOpenAiSse(res, opts.signal);
  }

  /** POST /v1/embeddings — returns embedding vectors (feature 5/6 consumer). */
  async embed(modelRef: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(this.url("/v1/embeddings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelRef, input }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MLX sidecar /v1/embeddings failed (${res.status}): ${text}`);
    }
    const body = (await res.json()) as { data?: { embedding: number[] }[] };
    return (body.data ?? []).map((d) => d.embedding);
  }
}
