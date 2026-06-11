/**
 * Shared chat-test helpers: a minimal InferenceGateway stub that records the
 * assembled prompt and streams a canned reply, plus an async-generator drain.
 * Used by memory-integration, prompt-grounding, and calendar-agenda tests.
 */

import type { InferenceGateway } from "../src/inference/gateway.js";

export interface GatewayStub {
  gateway: InferenceGateway;
  /** The messages array from the most recent gateway.chat() call. */
  messages: () => { role: string; content: string }[];
}

/**
 * Stub of InferenceGateway streaming `reply` as a single token. ChatCore only
 * touches: gateway.chat(), gateway.registry.defaultFor(),
 * gateway.modelManager.isFallbackActive(), and (via memory tests) gateway.mlx.embed.
 */
export function makeGatewayStub(reply = "ok"): GatewayStub {
  let capturedMessages: { role: string; content: string }[] = [];
  const gateway = {
    chat: async function* (req: unknown, _signal?: AbortSignal) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: reply };
      yield { type: "done" as const };
    },
    registry: {
      defaultFor: (_kind: string, _target: string) => ({
        ctxWindow: 16_384,
        id: "test-model",
        modelRef: "test",
        kind: "chat",
        provider: "mlx",
      }),
    },
    modelManager: {
      isFallbackActive: () => false,
    },
    mlx: {
      embed: async (_modelRef: string, texts: string[]) => texts.map(() => Array(256).fill(0)),
    },
  } as unknown as InferenceGateway;

  return { gateway, messages: () => capturedMessages };
}

/** Consume an async generator into an array. */
export async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}
