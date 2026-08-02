/**
 * router-cloud-provider.test.ts
 *
 * SC1 — proves the router resolves each task class to its D-04-configured
 * cloud provider, that escalation paths (token-overflow / RAM guard) with no
 * explicit cloudTaskProviders entry land on defaultCloudProvider, and that a
 * config rebalance (no code change) flips the resolved target. Bare Router +
 * a real Registry + a fake RamProbe — no gateway, no network.
 */
import { describe, expect, it } from "vitest";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { Registry } from "../src/inference/registry.js";
import { Router } from "../src/inference/router.js";
import type { RamProbe } from "../src/inference/ram.js";
import type { RoutingConfig } from "../src/config.js";
import type { JarvisInferenceRequest, RegistryEntry, TaskHint } from "../src/inference/types.js";

function makeRoutingConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    agentLocalTokenCap: 12_000,
    localCtxSafe: 14_000,
    ramFloorGB: 0,
    agentLatencyBudgetMs: 2_000,
    cloudTaskProviders: { consolidation: "fireworks", reasoning: "anthropic", agent: "anthropic" },
    defaultCloudProvider: "fireworks",
    agentPreferCloud: true,
    ...overrides,
  };
}

function makeRegistry(): Registry {
  const entries: RegistryEntry[] = [
    {
      id: "local-chat",
      kind: "chat",
      provider: "mlx",
      modelRef: "fake/local-chat",
      ctxWindow: 16384,
      default: true,
    },
    {
      id: "fireworks-heavy",
      kind: "chat",
      provider: "fireworks",
      modelRef: "fake/fireworks-heavy",
      ctxWindow: 262144,
      default: true,
    },
    {
      id: "anthropic-agent",
      kind: "chat",
      provider: "anthropic",
      modelRef: "fake/anthropic-agent",
      ctxWindow: 1_000_000,
      default: true,
    },
    {
      id: "local-embed",
      kind: "embedding",
      provider: "mlx",
      modelRef: "fake/local-embed",
      default: true,
    },
  ];
  return new Registry(entries);
}

const AMPLE_RAM: RamProbe = { headroomGB: () => 999, totalGB: () => 999 };

function request(taskHint: TaskHint, content: string, forceTarget?: JarvisInferenceRequest["forceTarget"]): JarvisInferenceRequest {
  return {
    messages: [{ role: "user", content }],
    stream: true,
    taskHint,
    forceTarget,
  };
}

/** A request whose user message carries an image content part (Tier 3's
 * computer_screenshot shape). */
function imageRequest(
  taskHint: TaskHint,
  forceTarget?: JarvisInferenceRequest["forceTarget"],
): JarvisInferenceRequest {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is on screen?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
    stream: true,
    taskHint,
    forceTarget,
  };
}

// Varied-vocabulary word cycle (NOT a repeated single character) — repeated
// single characters compress far too well under BPE to reliably cross a
// token ceiling. estimateRequestTokens (services/core/src/inference/tokens.ts)
// is backed by the REAL cl100k_base tokenizer, not a chars/4 heuristic, so
// the exact word counts below were computed empirically against that same
// tokenizer (countTokens(content) + 4 message-framing overhead, matching
// estimateRequestTokens's per-message +4):
//   8000 words -> 13604 est. tokens (> agentLocalTokenCap 12000, < localCtxSafe 14000)
//   9000 words -> 15304 est. tokens (> localCtxSafe 14000)
const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
  "quebec", "romeo", "sierra", "tango",
];
function wordsContent(n: number): string {
  const arr: string[] = [];
  for (let i = 0; i < n; i++) arr.push(WORDS[i % WORDS.length] as string);
  return arr.join(" ");
}
const OVER_AGENT_CAP_UNDER_CEILING = wordsContent(8_000); // ~13604 est. tokens
const OVER_LOCAL_CTX_SAFE = wordsContent(9_000); // ~15304 est. tokens

describe("sanity: computed fixtures actually straddle the intended thresholds", () => {
  it("OVER_AGENT_CAP_UNDER_CEILING is between agentLocalTokenCap and localCtxSafe", () => {
    const tokens = countTokens(OVER_AGENT_CAP_UNDER_CEILING) + 4;
    expect(tokens).toBeGreaterThan(12_000);
    expect(tokens).toBeLessThan(14_000);
  });

  it("OVER_LOCAL_CTX_SAFE clears localCtxSafe", () => {
    const tokens = countTokens(OVER_LOCAL_CTX_SAFE) + 4;
    expect(tokens).toBeGreaterThan(14_000);
  });
});

describe("Router.cloudTargetFor — single source of truth for cloud selection", () => {
  const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());

  it("consolidation -> cloudTaskProviders.consolidation", () => {
    expect(router.cloudTargetFor("consolidation")).toBe("fireworks");
  });
  it("reasoning -> cloudTaskProviders.reasoning", () => {
    expect(router.cloudTargetFor("reasoning")).toBe("anthropic");
  });
  it("agent -> cloudTaskProviders.agent", () => {
    expect(router.cloudTargetFor("agent")).toBe("anthropic");
  });
  it("voice -> defaultCloudProvider (no explicit entry)", () => {
    expect(router.cloudTargetFor("voice")).toBe("fireworks");
  });
  it("chat -> defaultCloudProvider (no explicit entry)", () => {
    expect(router.cloudTargetFor("chat")).toBe("fireworks");
  });
  it("embedding -> defaultCloudProvider (no explicit entry)", () => {
    expect(router.cloudTargetFor("embedding")).toBe("fireworks");
  });
  it("rerank -> defaultCloudProvider (no explicit entry)", () => {
    expect(router.cloudTargetFor("rerank")).toBe("fireworks");
  });
});

describe("Router.resolve — task-class routing matrix", () => {
  it("consolidation resolves to fireworks (task-cloud)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    const decision = router.resolve(request("consolidation", "compact memories"));
    expect(decision.target).toBe("fireworks");
    expect(decision.modelId).toBe("fireworks-heavy");
    expect(decision.reason).toBe("task-cloud");
  });

  it("reasoning resolves to anthropic (task-cloud)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    const decision = router.resolve(request("reasoning", "think hard"));
    expect(decision.target).toBe("anthropic");
    expect(decision.modelId).toBe("anthropic-agent");
    expect(decision.reason).toBe("task-cloud");
  });

  it("agent with agentPreferCloud true resolves to anthropic (task-cloud) regardless of prompt size", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig({ agentPreferCloud: true }));
    const decision = router.resolve(request("agent", "do a small thing"));
    expect(decision.target).toBe("anthropic");
    expect(decision.reason).toBe("task-cloud");
  });

  it("agent with agentPreferCloud false and a small prompt resolves to local (task-local)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig({ agentPreferCloud: false }));
    const decision = router.resolve(request("agent", "do a small thing"));
    expect(decision.target).toBe("local");
    expect(decision.reason).toBe("task-local");
  });

  it("agent with agentPreferCloud false and a prompt over agentLocalTokenCap escalates to anthropic (token-overflow)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig({ agentPreferCloud: false }));
    const decision = router.resolve(request("agent", OVER_AGENT_CAP_UNDER_CEILING));
    expect(decision.target).toBe("anthropic");
    expect(decision.reason).toBe("token-overflow");
  });

  it("chat with a small prompt resolves to local (task-local)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    const decision = router.resolve(request("chat", "hi there"));
    expect(decision.target).toBe("local");
    expect(decision.reason).toBe("task-local");
  });

  it("chat with a prompt over localCtxSafe escalates to defaultCloudProvider (token-overflow) [Pitfall 2 / A1]", () => {
    const cfg = makeRoutingConfig();
    const router = new Router(makeRegistry(), AMPLE_RAM, cfg);
    const decision = router.resolve(request("chat", OVER_LOCAL_CTX_SAFE));
    expect(decision.target).toBe(cfg.defaultCloudProvider);
    expect(decision.target).toBe("fireworks");
    expect(decision.reason).toBe("token-overflow");
  });

  it("a RamProbe reporting headroom below ramFloorGB downgrades a local pick to defaultCloudProvider (local-unavailable-fallback)", () => {
    const lowRam: RamProbe = { headroomGB: () => 0.5, totalGB: () => 16 };
    const cfg = makeRoutingConfig({ ramFloorGB: 2 });
    const router = new Router(makeRegistry(), lowRam, cfg);
    const decision = router.resolve(request("chat", "hi there"));
    expect(decision.target).toBe("fireworks");
    expect(decision.reason).toBe("local-unavailable-fallback");
  });

  it("forceTarget honors the explicit override regardless of task hint (forced)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    const decision = router.resolve(request("chat", "hi there", "anthropic"));
    expect(decision.target).toBe("anthropic");
    expect(decision.reason).toBe("forced");
  });

  it('forceTarget="local" under RAM pressure is NOT downgraded to cloud — the privacy pin holds (WR-02)', () => {
    const lowRam: RamProbe = { headroomGB: () => 0.5, totalGB: () => 16 };
    const router = new Router(makeRegistry(), lowRam, makeRoutingConfig({ ramFloorGB: 2 }));
    const decision = router.resolve(request("chat", "do not send this to the cloud", "local"));
    expect(decision.target).toBe("local");
    expect(decision.reason).toBe("forced");
  });

  it("embedding with a token-overflow-sized prompt stays LOCAL — no cloud embedding entry exists to escalate to (WR-03)", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    const decision = router.resolve(request("embedding", OVER_LOCAL_CTX_SAFE));
    expect(decision.target).toBe("local");
    expect(decision.modelId).toBe("local-embed");
    expect(decision.reason).toBe("task-local");
  });

  it("embedding under RAM pressure stays LOCAL — the RAM downgrade only applies to chat-kind hints (WR-03)", () => {
    const lowRam: RamProbe = { headroomGB: () => 0.5, totalGB: () => 16 };
    const router = new Router(makeRegistry(), lowRam, makeRoutingConfig({ ramFloorGB: 2 }));
    const decision = router.resolve(request("embedding", "embed me"));
    expect(decision.target).toBe("local");
    expect(decision.modelId).toBe("local-embed");
  });

  it('an unknown routing target (stale forceTarget "hf") throws a config-style error naming the target (WR-03)', () => {
    const registry = makeRegistry();
    expect(() => registry.defaultFor("chat", "hf" as never)).toThrow(
      /Unknown routing target "hf"/,
    );
  });

  // 15 WR-08: an image-bearing request must never be ROUTED local — the MLX
  // chat model has no vision support, so a local pick means loading the 4B
  // model on a fanless Air only to throw and fall over to cloud.
  it('a chat request carrying an image resolves to cloud, never local (task-cloud)', () => {
    const cfg = makeRoutingConfig();
    const router = new Router(makeRegistry(), AMPLE_RAM, cfg);
    const decision = router.resolve(imageRequest("chat"));
    expect(decision.target).not.toBe("local");
    expect(decision.target).toBe(cfg.defaultCloudProvider);
    expect(decision.reason).toBe("task-cloud");
  });

  it("a voice request carrying an image also resolves to cloud", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    expect(router.resolve(imageRequest("voice")).target).not.toBe("local");
  });

  it("an image-bearing reasoning request still resolves to its configured cloud provider", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    expect(router.resolve(imageRequest("reasoning")).target).toBe("anthropic");
  });

  it('forceTarget still wins over the image pin — forceTarget:"local" is honored (the provider then fails loudly)', () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    const decision = router.resolve(imageRequest("chat", "local"));
    expect(decision.target).toBe("local");
    expect(decision.reason).toBe("forced");
  });

  it("a text-only chat request is unaffected and still resolves local", () => {
    const router = new Router(makeRegistry(), AMPLE_RAM, makeRoutingConfig());
    expect(router.resolve(request("chat", "hi there")).target).toBe("local");
  });

  it("SC1 heart — a config rebalance (consolidation -> anthropic) flips the resolved target with ZERO code change", () => {
    const rebalanced = makeRoutingConfig({
      cloudTaskProviders: { consolidation: "anthropic", reasoning: "anthropic", agent: "anthropic" },
    });
    const router = new Router(makeRegistry(), AMPLE_RAM, rebalanced);
    const decision = router.resolve(request("consolidation", "compact memories"));
    expect(decision.target).toBe("anthropic");
    expect(decision.reason).toBe("task-cloud");
  });
});
