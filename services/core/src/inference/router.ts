/**
 * Router (feature 1): deterministic local-vs-cloud routing.
 *
 * Rule order (must not change — see feature 1 spec "Local vs cloud routing"):
 *   1. forceTarget set            -> honor it (reason: forced)
 *   5. estPromptTokens > localCtxSafe -> cloud (token-overflow)   [hard ceiling]
 *   2. consolidation | reasoning  -> cloud (task-cloud)
 *   3. voice | chat               -> local (task-local)
 *   4. agent                      -> cloud by default (agentPreferCloud, D-04),
 *                                    or local-first with escalation on
 *                                    token/latency budget when agentPreferCloud
 *                                    is false
 *   6. embedding | rerank         -> local (task-local)
 *
 * Which CLOUD PROVIDER serves a cloud-bound task hint is config-driven —
 * see cloudTargetFor() below, the single place that answers "which cloud
 * provider serves this task hint" (routing.cloudTaskProviders /
 * routing.defaultCloudProvider). The gateway calls it too, so the map is
 * never duplicated.
 *
 * Pre-flight RAM guard in decide(): a local pick with no headroom is downgraded
 * to the hint's configured cloud provider (local-unavailable-fallback).
 */
import type { RoutingConfig } from "../config.js";
import type { RamProbe } from "./ram.js";
import type { Registry } from "./registry.js";
import { estimateRequestTokens } from "./tokens.js";
import { logRouting } from "./telemetry.js";
import type {
  CloudTarget,
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

  /**
   * Which cloud provider serves a given task hint (D-04). Single source of
   * truth for cloud selection — the gateway reuses this instead of
   * duplicating the map. A switch (not an index expression) keeps
   * noUncheckedIndexedAccess satisfied.
   */
  cloudTargetFor(hint: TaskHint): CloudTarget {
    switch (hint) {
      case "consolidation":
        return this.cfg.cloudTaskProviders.consolidation;
      case "reasoning":
        return this.cfg.cloudTaskProviders.reasoning;
      case "agent":
        return this.cfg.cloudTaskProviders.agent;
      default:
        return this.cfg.defaultCloudProvider;
    }
  }

  resolve(req: JarvisInferenceRequest): RoutingDecision {
    const estPromptTokens = estimateRequestTokens(req.messages, req.tools);

    // 1. explicit override / escape hatch
    if (req.forceTarget) {
      return this.decide(req.forceTarget, req.taskHint, "forced", estPromptTokens);
    }

    // 5. hard context ceiling — overrides task preference. Chat-kind hints
    // only (WR-03): no cloud embedding/reranker registry entries exist, so a
    // cloud escalation for embedding/rerank would resolve a nonexistent
    // (kind, target) pair and throw instead of routing.
    if (kindFor(req.taskHint) === "chat" && estPromptTokens > this.cfg.localCtxSafe) {
      return this.decide(
        this.cloudTargetFor(req.taskHint),
        req.taskHint,
        "token-overflow",
        estPromptTokens,
      );
    }

    switch (req.taskHint) {
      // 2. heavy / long agentic work -> cloud (don't throttle the fanless Air)
      case "consolidation":
      case "reasoning":
        return this.decide(
          this.cloudTargetFor(req.taskHint),
          req.taskHint,
          "task-cloud",
          estPromptTokens,
        );

      // 3. latency-critical short turns -> local
      case "voice":
      case "chat":
        return this.decide("local", req.taskHint, "task-local", estPromptTokens);

      // 4. agent: cloud by default (agentPreferCloud, D-04); when disabled,
      // local-first with escalation on token/latency budget.
      case "agent": {
        if (this.cfg.agentPreferCloud) {
          return this.decide(
            this.cloudTargetFor("agent"),
            "agent",
            "task-cloud",
            estPromptTokens,
          );
        }
        const overBudget =
          estPromptTokens > this.cfg.agentLocalTokenCap ||
          this.expectLoopOverLatencyBudget(req);
        return overBudget
          ? this.decide(this.cloudTargetFor("agent"), "agent", "token-overflow", estPromptTokens)
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
    // pre-flight RAM guard: a local pick with no headroom is downgraded to
    // the hint's configured cloud provider. FORCED picks are exempt (WR-02):
    // rule 1 is "forceTarget set -> honor it", and forceTarget:"local" is
    // plausibly a privacy/cost decision ("do not send this to the cloud") —
    // silently rerouting it to a cloud provider breaks that contract. A
    // forced-local pick under pressure fails loudly at load time instead
    // (the gateway's fallback paths carry the same exemption). Non-chat kinds
    // (embedding/rerank) are exempt too (WR-03): they have no cloud registry
    // entries to downgrade to.
    if (
      reason !== "forced" &&
      kindFor(hint) === "chat" &&
      target === "local" &&
      this.ram.headroomGB() < this.cfg.ramFloorGB
    ) {
      target = this.cloudTargetFor(hint);
      reason = "local-unavailable-fallback";
    }
    const modelId = this.registry.defaultFor(kindFor(hint), target).id;
    const decision: RoutingDecision = { target, modelId, reason, estPromptTokens };
    logRouting(decision);
    return decision;
  }
}
