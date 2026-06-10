/**
 * Router (feature 1): deterministic local-vs-cloud routing.
 *
 * Rule order (must not change — see feature 1 spec "Local vs cloud routing"):
 *   1. forceTarget set            -> honor it (reason: forced)
 *   5. estPromptTokens > localCtxSafe -> hf (token-overflow)   [hard ceiling]
 *   2. consolidation | reasoning  -> hf (task-cloud)
 *   3. voice | chat               -> local (task-local)
 *   4. agent                      -> local, escalate to hf on token/latency budget
 *   6. embedding | rerank         -> local (task-local)
 *
 * Pre-flight RAM guard in decide(): a local pick with no headroom is downgraded
 * to HF (local-unavailable-fallback).
 */
import type { RoutingConfig } from "../config.js";
import type { RamProbe } from "./ram.js";
import type { Registry } from "./registry.js";
import { estimateRequestTokens } from "./tokens.js";
import { logRouting } from "./telemetry.js";
import type {
  JarvisInferenceRequest,
  ModelKind,
  RoutingDecision,
  RoutingReason,
  Target,
  TaskHint,
} from "./types.js";

/** Map a task hint to the registry model kind it needs. */
export function kindFor(hint: TaskHint): ModelKind {
  switch (hint) {
    case "embedding":
      return "embedding";
    case "rerank":
      return "reranker";
    default:
      return "chat";
  }
}

export class Router {
  constructor(
    private readonly registry: Registry,
    private readonly ram: RamProbe,
    private readonly cfg: RoutingConfig,
  ) {}

  resolve(req: JarvisInferenceRequest): RoutingDecision {
    const estPromptTokens = estimateRequestTokens(req.messages, req.tools);

    // 1. explicit override / escape hatch
    if (req.forceTarget) {
      return this.decide(req.forceTarget, req.taskHint, "forced", estPromptTokens);
    }

    // 5. hard context ceiling — overrides task preference
    if (estPromptTokens > this.cfg.localCtxSafe) {
      return this.decide("hf", req.taskHint, "token-overflow", estPromptTokens);
    }

    switch (req.taskHint) {
      // 2. heavy / long agentic work -> cloud (don't throttle the fanless Air)
      case "consolidation":
      case "reasoning":
        return this.decide("hf", req.taskHint, "task-cloud", estPromptTokens);

      // 3. latency-critical short turns -> local
      case "voice":
      case "chat":
        return this.decide("local", req.taskHint, "task-local", estPromptTokens);

      // 4. agent: local by default, escalate on token/latency budget
      case "agent": {
        const overBudget =
          estPromptTokens > this.cfg.agentLocalTokenCap ||
          this.expectLoopOverLatencyBudget(req);
        return overBudget
          ? this.decide("hf", "agent", "token-overflow", estPromptTokens)
          : this.decide("local", "agent", "task-local", estPromptTokens);
      }

      // 6. tiny, cheap -> local registry default
      case "embedding":
      case "rerank":
        return this.decide("local", req.taskHint, "task-local", estPromptTokens);
    }
  }

  /**
   * Heuristic: will the agent tool-loop blow the latency budget?
   * Phase 1 proxy: presence of many tools + a non-trivial prompt suggests a long
   * loop. TODO(phase4: feature 16) replace with real loop-latency telemetry.
   */
  private expectLoopOverLatencyBudget(req: JarvisInferenceRequest): boolean {
    const toolCount = req.tools?.length ?? 0;
    // No real timing yet; only escalate when clearly tool-heavy.
    return toolCount >= 8;
  }

  private decide(
    target: Target,
    hint: TaskHint,
    reason: RoutingReason,
    estPromptTokens: number,
  ): RoutingDecision {
    // pre-flight RAM guard: a local pick with no headroom is downgraded to HF
    if (target === "local" && this.ram.headroomGB() < this.cfg.ramFloorGB) {
      target = "hf";
      reason = "local-unavailable-fallback";
    }
    const modelId = this.registry.defaultFor(kindFor(hint), target).id;
    const decision: RoutingDecision = { target, modelId, reason, estPromptTokens };
    logRouting(decision);
    return decision;
  }
}
