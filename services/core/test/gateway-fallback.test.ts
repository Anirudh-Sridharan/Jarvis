/**
 * gateway-fallback.test.ts
 *
 * HF→local fallback (gateway.chat step 6): when the router targets HF and the
 * HF provider fails BEFORE any token (depleted credits/402, network, 5xx),
 * the gateway retries once on the local model instead of erroring the turn.
 */

import { describe, it, expect } from "vitest";
import { InferenceGateway } from "../src/inference/gateway.js";
import type { AppConfig } from "../src/config.js";
import type { InferenceStreamChunk } from "../src/inference/types.js";

function makeConfig(): AppConfig {
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
        id: "hf-heavy",
        kind: "chat",
        provider: "hf",
        modelRef: "fake/heavy-80b",
        ctxWindow: 131072,
      },
    ] as AppConfig["registry"],
    routing: { agentLocalTokenCap: 12000, localCtxSafe: 14000, ramFloorGB: 0, agentLatencyBudgetMs: 2000 },
    lifecycle: { idleMs: 600_000, killOnUnload: false },
    env: { corePort: 8080, mlxSidecarUrl: "http://127.0.0.1:1", hfEndpointUrl: "http://127.0.0.1:1", hfToken: "x" },
  };
}

async function collect(gen: AsyncGenerator<InferenceStreamChunk>): Promise<InferenceStreamChunk[]> {
  const chunks: InferenceStreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

function buildGateway(opts: { hfFails: boolean; localFails?: boolean }): InferenceGateway {
  const gw = new InferenceGateway(makeConfig());
  const failing = async function* (): AsyncGenerator<string> {
    throw new Error(
      'HF endpoint /v1/chat/completions failed (402): {"error":"You have depleted your monthly included credits."}',
    );
  };
  const speaking = async function* (): AsyncGenerator<string> {
    yield "hello ";
    yield "from local";
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (gw as any).hf = { streamChat: opts.hfFails ? failing : speaking };
  (gw as any).mlx = {
    streamChat: opts.localFails
      ? async function* (): AsyncGenerator<string> { throw new Error("sidecar down"); }
      : speaking,
  };
  (gw as any).modelManager.ensureReady = async () => {
    if (opts.localFails) throw new Error("local model failed to load");
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return gw;
}

// taskHint "reasoning" routes to HF
const HF_REQUEST = {
  messages: [{ role: "user" as const, content: "think hard" }],
  taskHint: "reasoning" as const,
};

describe("gateway HF→local fallback", () => {
  it("retries on the local model when HF fails before any token", async () => {
    const gw = buildGateway({ hfFails: true });
    const chunks = await collect(gw.chat(HF_REQUEST));

    const tokens = chunks.filter((c) => c.type === "token").map((c) => (c as { text: string }).text);
    expect(tokens.join("")).toBe("hello from local");
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(gw.modelManager.isFallbackActive()).toBe(true);
  });

  it("reports both failures when the local fallback also fails", async () => {
    const gw = buildGateway({ hfFails: true, localFails: true });
    const chunks = await collect(gw.chat(HF_REQUEST));

    const error = chunks.find((c) => c.type === "error") as { message: string } | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toContain("402");
    expect(error!.message).toContain("local fallback also failed");
    expect(chunks.some((c) => c.type === "token")).toBe(false);
  });

  it("does not fall back when HF succeeds", async () => {
    const gw = buildGateway({ hfFails: false });
    const chunks = await collect(gw.chat(HF_REQUEST));

    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(gw.modelManager.isFallbackActive()).toBe(false);
  });
});
