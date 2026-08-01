/**
 * gateway-fallback.test.ts
 *
 * SC4 — the 3-way gateway fallback matrix, in both directions, for both
 * cloud providers, with fake providers patched onto a real gateway (no
 * network, no credentials):
 *
 *   1. cloud-load/runtime failure BEFORE any token -> the turn completes on
 *      the local model instead of erroring (local-unavailable-fallback /
 *      oom-fallback), with modelManager.isFallbackActive() true.
 *   2. BOTH cloud and local fail -> exactly one structured error chunk,
 *      naming the failing cloud target and containing the original error
 *      text, no token chunk emitted.
 *   3. the cloud provider succeeds -> stream ends `done`, fallbackActive false.
 *   4. cross-provider isolation: the OTHER cloud provider's fake is never
 *      invoked for a given task hint (proves per-task-class dispatch, not
 *      "some cloud provider answered").
 *
 * Parameterized with describe.each over the D-04 task-class matrix
 * (consolidation->fireworks, agent->anthropic, reasoning->anthropic) instead
 * of one hardcoded fixture, per RESEARCH.md Pitfall 3 (full rewrite, not a
 * patch — the old file's `(gw as any).hf` monkey-patch no longer exists).
 */

import { describe, it, expect } from "vitest";
import { InferenceGateway } from "../src/inference/gateway.js";
import type { AppConfig } from "../src/config.js";
import type { CloudTarget, InferenceStreamChunk, TaskHint } from "../src/inference/types.js";

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
        id: "fireworks-heavy",
        kind: "chat",
        provider: "fireworks",
        modelRef: "fake/heavy-80b",
        ctxWindow: 262144,
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

interface CallCounters {
  fireworks: number;
  anthropic: number;
  mlx: number;
}

interface BuildGatewayOpts {
  cloudFails: boolean;
  localFails?: boolean;
  cloudTarget: CloudTarget;
}

function buildGateway(opts: BuildGatewayOpts): { gw: InferenceGateway; calls: CallCounters } {
  const gw = new InferenceGateway(makeConfig());
  const calls: CallCounters = { fireworks: 0, anthropic: 0, mlx: 0 };

  const failingCloud = async function* (): AsyncGenerator<string> {
    throw new Error(
      `${opts.cloudTarget} chat/completions failed (402): {"error":"You have depleted your monthly included credits."}`,
    );
  };
  const speaking = async function* (): AsyncGenerator<string> {
    yield "hello ";
    yield "from local";
  };
  const speakingCloud = async function* (): AsyncGenerator<string> {
    yield "hello ";
    yield "from cloud";
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fireworksFake = {
    streamChat: async function* (): AsyncGenerator<string> {
      calls.fireworks++;
      yield* opts.cloudTarget === "fireworks" && opts.cloudFails ? failingCloud() : speakingCloud();
    },
  };
  const anthropicFake = {
    streamChat: async function* (): AsyncGenerator<string> {
      calls.anthropic++;
      yield* opts.cloudTarget === "anthropic" && opts.cloudFails ? failingCloud() : speakingCloud();
    },
  };
  (gw as any).fireworks = fireworksFake;
  (gw as any).anthropic = anthropicFake;
  (gw as any).mlx = {
    streamChat: async function* (): AsyncGenerator<string> {
      calls.mlx++;
      if (opts.localFails) throw new Error("sidecar down");
      yield* speaking();
    },
  };
  (gw as any).modelManager.ensureReady = async () => {
    if (opts.localFails) throw new Error("local model failed to load");
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { gw, calls };
}

function requestFor(hint: TaskHint) {
  return {
    messages: [{ role: "user" as const, content: "think hard" }],
    taskHint: hint,
  };
}

describe.each([
  { hint: "consolidation" as const, cloudTarget: "fireworks" as const, other: "anthropic" as const },
  { hint: "agent" as const, cloudTarget: "anthropic" as const, other: "fireworks" as const },
  { hint: "reasoning" as const, cloudTarget: "anthropic" as const, other: "fireworks" as const },
])("gateway $cloudTarget fallback for taskHint=$hint", ({ hint, cloudTarget, other }) => {
  it("retries on the local model when the cloud provider fails before any token", async () => {
    const { gw } = buildGateway({ cloudFails: true, cloudTarget });
    const chunks = await collect(gw.chat(requestFor(hint)));

    const tokens = chunks.filter((c) => c.type === "token").map((c) => (c as { text: string }).text);
    expect(tokens.join("")).toBe("hello from local");
    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(gw.modelManager.isFallbackActive()).toBe(true);
  });

  it("reports both failures, naming the cloud target, when the local fallback also fails", async () => {
    const { gw } = buildGateway({ cloudFails: true, localFails: true, cloudTarget });
    const chunks = await collect(gw.chat(requestFor(hint)));

    const error = chunks.find((c) => c.type === "error") as { message: string } | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toContain(cloudTarget);
    expect(error!.message).toContain("402");
    expect(error!.message).toContain("local fallback also failed");
    expect(chunks.some((c) => c.type === "token")).toBe(false);
    expect(chunks.filter((c) => c.type === "error")).toHaveLength(1);
  });

  it("does not fall back when the cloud provider succeeds", async () => {
    const { gw } = buildGateway({ cloudFails: false, cloudTarget });
    const chunks = await collect(gw.chat(requestFor(hint)));

    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(gw.modelManager.isFallbackActive()).toBe(false);
  });

  it(`never calls the ${other} provider's fake for this task hint (per-task-class dispatch, not "some cloud provider answered")`, async () => {
    const { gw, calls } = buildGateway({ cloudFails: false, cloudTarget });
    await collect(gw.chat(requestFor(hint)));

    expect(calls[cloudTarget]).toBeGreaterThan(0);
    expect(calls[other]).toBe(0);
  });
});
