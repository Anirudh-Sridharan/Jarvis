/**
 * chatContentParts.test.ts
 *
 * Phase 15 Tier 3 plumbing: the ContentPart widening of ChatMessage.content
 * (types.ts) plus the local-fallback guard it enables (mlxProvider.ts,
 * gateway.ts). Task 1 covers the pure helpers; Task 2 extends this file with
 * the MlxProvider vision-refusal case and the gateway cloud-pin case.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  messageText,
  messageHasImagePart,
  requestHasImagePart,
  type ChatMessage,
} from "../src/inference/types.js";
import { MlxProvider } from "../src/inference/providers/mlxProvider.js";
import { InferenceGateway } from "../src/inference/gateway.js";
import type { AppConfig } from "../src/config.js";
import type { InferenceStreamChunk } from "../src/inference/types.js";

describe("messageText", () => {
  it("returns a plain string unchanged", () => {
    expect(messageText("hello world")).toBe("hello world");
  });

  it("joins text parts with a newline", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "text" as const, text: "second" },
    ];
    expect(messageText(content)).toBe("first\nsecond");
  });

  it("ignores image parts in a mixed array", () => {
    const content = [
      { type: "text" as const, text: "look at this" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAA" } },
    ];
    expect(messageText(content)).toBe("look at this");
  });

  it("returns an empty string for an image-only array", () => {
    const content = [
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAA" } },
    ];
    expect(messageText(content)).toBe("");
  });
});

describe("messageHasImagePart", () => {
  it("is false for a plain-string message", () => {
    const msg: ChatMessage = { role: "user", content: "hi" };
    expect(messageHasImagePart(msg)).toBe(false);
  });

  it("is false for a text-only parts array", () => {
    const msg: ChatMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    expect(messageHasImagePart(msg)).toBe(false);
  });

  it("is true when a parts array contains an image_url part", () => {
    const msg: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    };
    expect(messageHasImagePart(msg)).toBe(true);
  });
});

describe("requestHasImagePart", () => {
  it("is false for undefined", () => {
    expect(requestHasImagePart(undefined)).toBe(false);
  });

  it("is false for an empty array", () => {
    expect(requestHasImagePart([])).toBe(false);
  });

  it("is true when any message in a mixed list carries an image part", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      {
        role: "user",
        content: [
          { type: "text", text: "what's this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    expect(requestHasImagePart(messages)).toBe(true);
  });

  it("is false when no message in the list carries an image part", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
    ];
    expect(requestHasImagePart(messages)).toBe(false);
  });
});

// ── MlxProvider vision refusal ─────────────────────────────────────────────
// The local MLX sidecar has no vision support; an image-bearing request must
// be refused BEFORE any fetch, never silently forwarded to a model that
// cannot interpret the image (15-RESEARCH.md Open Question 1).
describe("MlxProvider.streamChat refuses image content before any fetch", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects with a /no vision support/i message and never calls fetch", async () => {
    const provider = new MlxProvider("http://127.0.0.1:1");
    const imageMessages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what's on screen?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];

    const gen = provider.streamChat({ modelRef: "fake/local-4b", messages: imageMessages });
    await expect(gen.next()).rejects.toThrow(/no vision support/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Gateway: image-bearing requests are cloud-pinned ───────────────────────
// Reuses the gateway-fallback.test.ts fake-provider-patching technique: a
// real InferenceGateway with its provider fields monkey-patched, no network.
function makeImagePinConfig(): AppConfig {
  return {
    registry: [
      {
        id: "local-chat",
        kind: "chat",
        provider: "mlx",
        modelRef: "fake/local-4b",
        ctxWindow: 16384,
        approxRamGB: 6,
        default: true,
      },
      {
        id: "anthropic-agent",
        kind: "chat",
        provider: "anthropic",
        modelRef: "fake/claude-sonnet",
        ctxWindow: 1_000_000,
        default: true,
      },
    ] as AppConfig["registry"],
    routing: {
      agentLocalTokenCap: 12_000,
      localCtxSafe: 14_000,
      ramFloorGB: 0,
      agentLatencyBudgetMs: 2_000,
      cloudTaskProviders: { consolidation: "fireworks", reasoning: "anthropic", agent: "anthropic" },
      defaultCloudProvider: "fireworks",
      agentPreferCloud: true,
    },
    lifecycle: { idleMs: 600_000, killOnUnload: false },
    env: {
      corePort: 8080,
      mlxSidecarUrl: "http://127.0.0.1:1",
      fireworksApiKey: "test-fireworks-key",
      fireworksEndpointUrl: "http://127.0.0.1:1",
      anthropicApiKey: "test-anthropic-key",
      anthropicEndpointUrl: "http://127.0.0.1:1",
    },
  };
}

async function collect(gen: AsyncGenerator<InferenceStreamChunk>): Promise<InferenceStreamChunk[]> {
  const chunks: InferenceStreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe("gateway pins image-bearing requests to cloud (never retries local)", () => {
  it("a cloud failure on an image-bearing reasoning request errors with /image content/i and never invokes the local provider", async () => {
    const gw = new InferenceGateway(makeImagePinConfig());
    let mlxCalls = 0;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (gw as any).anthropic = {
      streamChat: async function* (): AsyncGenerator<string> {
        throw new Error("anthropic chat/completions failed (500): server exploded");
      },
    };
    (gw as any).mlx = {
      streamChat: async function* (): AsyncGenerator<string> {
        mlxCalls++;
        yield "should never happen";
      },
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const imageMessages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what's on screen?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    const chunks = await collect(gw.chat({ messages: imageMessages, taskHint: "reasoning" }));

    const errors = chunks.filter((c) => c.type === "error") as { message: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/image content/i);
    expect(chunks.some((c) => c.type === "token")).toBe(false);
    expect(mlxCalls).toBe(0);
  });
});
