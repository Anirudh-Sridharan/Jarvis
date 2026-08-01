/**
 * Generic OpenAI-compatible provider client (feature 13.1): talks to ANY
 * cloud provider that exposes an OpenAI-shaped /chat/completions endpoint —
 * currently Fireworks AI (heavy consolidation lane) and Anthropic Claude
 * (reasoning/agent lane, via its OpenAI-SDK-compat surface).
 *
 * This is the ONE parameterized class that serves both providers, not two
 * hand-copied provider classes: provider identity (base URL, API key,
 * per-provider max_tokens default, error-message label) comes entirely from
 * constructor options, never from the class body. Adding a future
 * OpenAI-compatible provider means adding a constructor call in gateway.ts,
 * not a new file.
 *
 * Auth: Authorization: Bearer ${apiKey} — both Fireworks and Anthropic's
 * OpenAI-compat layer use plain Bearer auth (Anthropic's native
 * x-api-key/anthropic-version headers are deliberately NOT used here).
 */
import { parseOpenAiSse } from "./sse.js";
import type { ChatProvider, DispatchOptions } from "../types.js";

/** Fireworks AI serverless OpenAI-compatible base URL. */
export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
/** Anthropic's OpenAI-SDK-compatible base URL. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
/** Fallback max_tokens when neither the caller nor the instance supplies one. */
export const DEFAULT_MAX_TOKENS = 8192;
/** Non-2xx response bodies are truncated to this many chars before being embedded in a thrown Error. */
export const MAX_ERROR_BODY_CHARS = 500;

export interface OpenAiCompatProviderOptions {
  /** Base URL (e.g. FIREWORKS_BASE_URL) or a full chat-completions URL. */
  endpointUrl: string;
  apiKey: string | undefined;
  /** Per-instance max_tokens fallback (Anthropic's compat layer requires one; Fireworks doesn't). */
  defaultMaxTokens?: number;
  /** Provider name used in error messages only — never affects request shape. */
  label?: string;
}

/**
 * ONE OpenAI-compatible chat client, instantiated once per cloud provider
 * (Fireworks, Anthropic) with different constructor options.
 */
export class OpenAiCompatProvider implements ChatProvider {
  constructor(private readonly opts: OpenAiCompatProviderOptions) {}

  private providerLabel(): string {
    return this.opts.label ?? "cloud provider";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) h["authorization"] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  /**
   * Endpoint URL may already include /chat/completions, or may be a bare
   * base URL that carries its own path prefix (e.g. Fireworks'
   * /inference/v1). Always join with a RELATIVE path so an existing prefix
   * survives — a leading-slash join (`new URL("/chat/completions", base)`)
   * would replace the whole path and destroy that prefix.
   */
  private chatUrl(): string {
    const endpoint = this.opts.endpointUrl;
    if (endpoint.includes("/chat/completions")) return endpoint;
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    return new URL("chat/completions", base).toString();
  }

  async *streamChat(opts: DispatchOptions): AsyncGenerator<string, void, unknown> {
    if (!this.opts.endpointUrl) {
      throw new Error(
        `${this.providerLabel()} endpoint not configured — cannot route this request to cloud.`,
      );
    }
    const res = await fetch(this.chatUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.modelRef,
        messages: opts.messages,
        ...(opts.tools ? { tools: opts.tools } : {}),
        // ALWAYS present (unlike HfProvider's conditional spread): Anthropic's
        // OpenAI-compat layer rejects requests with no max_tokens (Pitfall 1).
        max_tokens: opts.maxTokens ?? this.opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const truncated =
        text.length > MAX_ERROR_BODY_CHARS ? text.slice(0, MAX_ERROR_BODY_CHARS) : text;
      throw new Error(
        `${this.providerLabel()} chat/completions failed (${res.status}): ${truncated}`,
      );
    }
    yield* parseOpenAiSse(res, opts.signal);
  }
}
