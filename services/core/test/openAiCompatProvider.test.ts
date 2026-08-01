/**
 * openAiCompatProvider.test.ts
 *
 * Hermetic, fetch-stubbed coverage of the ONE OpenAI-compatible provider
 * client shared by Fireworks and Anthropic: URL join (both base-URL shapes,
 * trailing slash, already-full-URL passthrough), Bearer auth, max_tokens
 * precedence, structured non-crashing error surfacing (never leaking the
 * API key), and SSE delta decoding. No network, no credentials — fetch is
 * stubbed with vi.fn() in beforeEach and restored in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_BASE_URL,
  DEFAULT_MAX_TOKENS,
  FIREWORKS_BASE_URL,
  MAX_ERROR_BODY_CHARS,
  OpenAiCompatProvider,
} from "../src/inference/providers/openAiCompatProvider.js";
import type { DispatchOptions } from "../src/inference/types.js";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Builds one `data: {...}` SSE event carrying a content delta, blank-line terminated. */
function sseEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}
const DONE_EVENT = "data: [DONE]\n\n";

/** A fake streaming Response: two content deltas ("hello ", "world") then [DONE]. */
function makeFakeStreamResponse(): Response {
  const encoder = new TextEncoder();
  const events = [sseEvent("hello "), sseEvent("world"), DONE_EVENT];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** Drains an async generator of string deltas into a single joined string. */
async function drain(gen: AsyncGenerator<string, void, unknown>): Promise<string> {
  let out = "";
  for await (const piece of gen) out += piece;
  return out;
}

function makeDispatch(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    modelRef: "test-model",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function firstCall(): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

describe("OpenAiCompatProvider", () => {
  describe("chat/completions URL join", () => {
    it("joins the Fireworks base URL without clobbering the /inference/v1 prefix", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: FIREWORKS_BASE_URL, apiKey: "k" });
      await drain(provider.streamChat(makeDispatch()));
      const [url] = firstCall();
      expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    });

    it("joins the Anthropic base URL to /v1/chat/completions", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: ANTHROPIC_BASE_URL, apiKey: "k" });
      await drain(provider.streamChat(makeDispatch()));
      const [url] = firstCall();
      expect(url).toBe("https://api.anthropic.com/v1/chat/completions");
    });

    it("does not produce a doubled slash when the base URL already ends in /", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: `${FIREWORKS_BASE_URL}/`, apiKey: "k" });
      await drain(provider.streamChat(makeDispatch()));
      const [url] = firstCall();
      expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    });

    it("uses an endpointUrl that already ends in /chat/completions verbatim", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const verbatim = "https://custom.example.com/v2/chat/completions";
      const provider = new OpenAiCompatProvider({ endpointUrl: verbatim, apiKey: "k" });
      await drain(provider.streamChat(makeDispatch()));
      const [url] = firstCall();
      expect(url).toBe(verbatim);
    });
  });

  describe("auth header", () => {
    it("sends a Bearer authorization header and content-type when apiKey is set", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: FIREWORKS_BASE_URL, apiKey: "test-key-abc" });
      await drain(provider.streamChat(makeDispatch()));
      const [, init] = firstCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["authorization"]).toBe("Bearer test-key-abc");
      expect(headers["content-type"]).toBe("application/json");
    });

    it("omits the authorization header when apiKey is undefined", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: FIREWORKS_BASE_URL, apiKey: undefined });
      await drain(provider.streamChat(makeDispatch()));
      const [, init] = firstCall();
      const headers = init.headers as Record<string, string>;
      expect(headers["authorization"]).toBeUndefined();
    });
  });

  describe("max_tokens precedence", () => {
    it("defaults to DEFAULT_MAX_TOKENS when neither caller nor instance supplies one", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: FIREWORKS_BASE_URL, apiKey: "k" });
      await drain(provider.streamChat(makeDispatch()));
      const [, init] = firstCall();
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    });

    it("uses the instance defaultMaxTokens when the caller supplies none", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({
        endpointUrl: ANTHROPIC_BASE_URL,
        apiKey: "k",
        defaultMaxTokens: 4096,
      });
      await drain(provider.streamChat(makeDispatch()));
      const [, init] = firstCall();
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      expect(body.max_tokens).toBe(4096);
    });

    it("prefers the caller-supplied maxTokens over the instance default", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({
        endpointUrl: ANTHROPIC_BASE_URL,
        apiKey: "k",
        defaultMaxTokens: 4096,
      });
      await drain(provider.streamChat(makeDispatch({ maxTokens: 256 })));
      const [, init] = firstCall();
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      expect(body.max_tokens).toBe(256);
    });
  });

  describe("body passthrough", () => {
    it("passes model/messages/stream through and omits tools when the dispatch has none", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: FIREWORKS_BASE_URL, apiKey: "k" });
      const dispatch = makeDispatch({ modelRef: "some-model-ref" });
      await drain(provider.streamChat(dispatch));
      const [, init] = firstCall();
      const body = JSON.parse(init.body as string) as {
        model: string;
        messages: unknown[];
        stream: boolean;
        tools?: unknown;
      };
      expect(body.model).toBe(dispatch.modelRef);
      expect(body.messages).toEqual(dispatch.messages);
      expect(body.stream).toBe(true);
      expect(body.tools).toBeUndefined();
    });
  });

  describe("error surfacing (SC4/D-08)", () => {
    it("throws a structured Error naming status + label on a 401 without leaking the API key", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 }),
      );
      const provider = new OpenAiCompatProvider({
        endpointUrl: FIREWORKS_BASE_URL,
        apiKey: "test-key-abc",
        label: "fireworks",
      });

      let thrown: Error | undefined;
      try {
        await drain(provider.streamChat(makeDispatch()));
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain("401");
      expect(thrown!.message).toContain("fireworks");
      expect(thrown!.message).not.toContain("test-key-abc");
    });

    it("truncates a long non-ok response body to MAX_ERROR_BODY_CHARS", async () => {
      const longBody = "x".repeat(2000);
      fetchMock.mockResolvedValue(new Response(longBody, { status: 500 }));
      const provider = new OpenAiCompatProvider({
        endpointUrl: FIREWORKS_BASE_URL,
        apiKey: "k",
        label: "fireworks",
      });

      let thrown: Error | undefined;
      try {
        await drain(provider.streamChat(makeDispatch()));
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message.length).toBeLessThan(1000);
      expect(thrown!.message).toContain("x".repeat(MAX_ERROR_BODY_CHARS));
      expect(thrown!.message).not.toContain("x".repeat(MAX_ERROR_BODY_CHARS + 1));
    });
  });

  describe("unconfigured endpoint guard", () => {
    it("throws a not-configured error and never calls fetch when endpointUrl is empty", async () => {
      const provider = new OpenAiCompatProvider({ endpointUrl: "", apiKey: "k", label: "anthropic" });

      let thrown: Error | undefined;
      try {
        await drain(provider.streamChat(makeDispatch()));
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain("not configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("SSE decoding", () => {
    it("yields content deltas and terminates cleanly on [DONE]", async () => {
      fetchMock.mockResolvedValue(makeFakeStreamResponse());
      const provider = new OpenAiCompatProvider({ endpointUrl: FIREWORKS_BASE_URL, apiKey: "k" });
      const result = await drain(provider.streamChat(makeDispatch()));
      expect(result).toBe("hello world");
    });
  });
});
