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
import { GatewayLlm } from "../src/memory/gatewayLlm.js";
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
  /** Model LOAD failure — modelManager.ensureReady throws (lifecycle gate). */
  localFails?: boolean;
  /** RUNTIME failure — load succeeds but streamChat throws before any token (oom-fallback path). */
  localRuntimeFails?: boolean;
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
      if (opts.localFails || opts.localRuntimeFails) throw new Error("sidecar down");
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

// ── CR-01: consolidation is cloud-PINNED — a dead cloud lane must fail loudly, ──
// never silently persist local-4B output into the permanent memory graph.
describe("cloud-pinned consolidation (CR-01)", () => {
  it("a dead fireworks lane yields ONE structured error and NEVER retries on the local model", async () => {
    const { gw, calls } = buildGateway({ cloudFails: true, cloudTarget: "fireworks" });
    const chunks = await collect(gw.chat(requestFor("consolidation")));

    const errors = chunks.filter((c) => c.type === "error") as { message: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("fireworks");
    expect(errors[0]!.message).toContain("402");
    expect(errors[0]!.message).toContain("cloud-pinned");
    expect(chunks.some((c) => c.type === "token")).toBe(false);
    expect(chunks.some((c) => c.type === "done")).toBe(false);
    expect(calls.mlx).toBe(0);
  });

  it("GatewayLlm.complete REJECTS on a dead fireworks lane instead of returning local output (no degraded facts persisted)", async () => {
    const { gw, calls } = buildGateway({ cloudFails: true, cloudTarget: "fireworks" });
    const llm = new GatewayLlm(gw);

    await expect(llm.complete({ prompt: "extract facts" })).rejects.toThrow(/fireworks.*402/s);
    expect(calls.mlx).toBe(0);
  });

  it("a healthy fireworks lane completes normally with no fallback", async () => {
    const { gw, calls } = buildGateway({ cloudFails: false, cloudTarget: "fireworks" });
    const chunks = await collect(gw.chat(requestFor("consolidation")));

    expect(chunks.at(-1)).toEqual({ type: "done" });
    expect(gw.modelManager.isFallbackActive()).toBe(false);
    expect(calls.anthropic).toBe(0);
    expect(calls.mlx).toBe(0);
  });
});

// ── WR-03: routing/registry throws surface as ERROR CHUNKS, not generator ──
// rejections — every gateway caller is written against the chunk contract.
describe("routing failures surface as error chunks (WR-03)", () => {
  it('a stale forceTarget "hf" yields a structured error chunk naming the bad target instead of rejecting', async () => {
    const { gw } = buildGateway({ cloudFails: false, cloudTarget: "fireworks" });
    const chunks = await collect(
      gw.chat({
        messages: [{ role: "user" as const, content: "hi" }],
        taskHint: "chat",
        forceTarget: "hf" as never,
      }),
    );

    const error = chunks.find((c) => c.type === "error") as { message: string } | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toContain("Routing failed");
    expect(error!.message).toContain('Unknown routing target "hf"');
    expect(chunks.filter((c) => c.type === "error")).toHaveLength(1);
  });
});

// ── WR-02: forceTarget:"local" is a privacy/cost pin — the request must ──
// NEVER be silently shipped to a cloud provider, whatever fails.
describe('forceTarget="local" privacy pin (WR-02)', () => {
  const forcedLocalReq = {
    messages: [{ role: "user" as const, content: "keep this on-device" }],
    taskHint: "chat" as const,
    forceTarget: "local" as const,
  };

  it("a local LOAD failure yields a structured error — no cloud provider is ever called", async () => {
    const { gw, calls } = buildGateway({ cloudFails: false, localFails: true, cloudTarget: "fireworks" });
    const chunks = await collect(gw.chat(forcedLocalReq));

    const error = chunks.find((c) => c.type === "error") as { message: string } | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toContain('forceTarget="local"');
    expect(chunks.some((c) => c.type === "token")).toBe(false);
    expect(calls.fireworks).toBe(0);
    expect(calls.anthropic).toBe(0);
  });

  it("a local RUNTIME failure before any token yields a structured error — no cloud provider is ever called", async () => {
    const { gw, calls } = buildGateway({
      cloudFails: false,
      localRuntimeFails: true,
      cloudTarget: "fireworks",
    });
    const chunks = await collect(gw.chat(forcedLocalReq));

    const error = chunks.find((c) => c.type === "error") as { message: string } | undefined;
    expect(error).toBeDefined();
    expect(error!.message).toContain("sidecar down");
    expect(chunks.some((c) => c.type === "token")).toBe(false);
    expect(calls.fireworks).toBe(0);
    expect(calls.anthropic).toBe(0);
  });
});

// ── WR-01: a token-overflow-routed prompt physically cannot fit the local ──
// context — a dead cloud lane must error, not retry on a model that can't
// serve it (truncated prompt or hard sidecar error).
describe("cloud-pinned token overflow (WR-01)", () => {
  // Varied-vocabulary word cycle so BPE cannot compress it below the ceiling
  // (same technique as router-cloud-provider.test.ts): 9000 words ≈ 15.3k
  // estimated tokens > localCtxSafe 14000.
  const WORDS = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango",
  ];
  const overflowContent = Array.from({ length: 9_000 }, (_, i) => WORDS[i % WORDS.length]).join(" ");

  it("a chat prompt over localCtxSafe whose cloud lane dies yields ONE structured error and never retries locally", async () => {
    // chat overflows to defaultCloudProvider = fireworks (see makeConfig).
    const { gw, calls } = buildGateway({ cloudFails: true, cloudTarget: "fireworks" });
    const chunks = await collect(
      gw.chat({ messages: [{ role: "user" as const, content: overflowContent }], taskHint: "chat" }),
    );

    const errors = chunks.filter((c) => c.type === "error") as { message: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("fireworks");
    expect(errors[0]!.message).toContain("exceeds the local context ceiling");
    expect(chunks.some((c) => c.type === "token")).toBe(false);
    expect(calls.mlx).toBe(0);
  });
});
