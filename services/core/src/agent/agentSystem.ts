/**
 * agentSystem — lazy singleton factory for the @jarvis/agent AgentSystem wired
 * with:
 *   - AgentLlm (gateway → HF, taskHint:'agent')
 *   - Real tool registry (calendar, todos, web, email)
 *   - Real Clock (Date.now())
 *   - JARVIS_DATA_DIR for SQLite persistence
 *   - ApprovalQueue: in-memory queue the dashboard/menu-bar polls
 *
 * The ApprovalQueue is exported so server.ts can expose /approvals endpoints.
 */

import { createAgentSystem } from "@jarvis/agent";
import type { AgentSystem, ApprovalRequest, ApprovalDecision, Clock } from "@jarvis/agent";
import type { IntegrationsSystem } from "@jarvis/integrations";
import type { MemorySystem } from "@jarvis/memory";
import type { McpToolClient } from "../mcp/playwrightMcp.js";
import type { InferenceGateway } from "../inference/gateway.js";
import { AgentLlm } from "./agentLlm.js";
import { buildToolRegistry } from "./tools/index.js";
import { getDataDir } from "../dataDir.js";
import { parseCronNext } from "./cronNext.js";

// ── Real clock ────────────────────────────────────────────────────────────────

export const realClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

// ── ApprovalQueue ─────────────────────────────────────────────────────────────

export interface QueuedApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  /** Epoch ms after which the entry is dead (the agent side times out independently). */
  expiresAt: number;
}

/** Matches @jarvis/agent's DEFAULT_APPROVAL_TIMEOUT_MS (safety/approval.ts). */
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory queue of pending approval requests.
 * The HTTP endpoints read from and write to this queue.
 * The dashboard / menu-bar polls GET /approvals and calls POST /approvals/:id/approve|reject.
 *
 * Entries carry an expiry mirroring the agent-side approval timeout: the agent
 * resolves its own timeout independently, so an expired entry here is dead —
 * listing it as pending (or returning ok:true on approve) would be a lie.
 */
export class ApprovalQueue {
  private queue = new Map<string, QueuedApproval>();

  /**
   * ApprovalSink — passed to createAgentSystem. Called whenever an action needs approval.
   * Returns a Promise that resolves when the user decides (or times out).
   */
  readonly sink = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    return new Promise<ApprovalDecision>((resolve) => {
      const parsed = request.expiresAt ? Date.parse(request.expiresAt) : NaN;
      const expiresAt = Number.isFinite(parsed)
        ? parsed
        : Date.now() + DEFAULT_APPROVAL_TTL_MS;
      this.queue.set(request.id, { request, resolve, expiresAt });
    });
  };

  /** Drop entries whose agent-side approval window has already closed. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.queue) {
      if (entry.expiresAt <= now) {
        this.queue.delete(id);
        // Settle the sink promise so it never leaks; the agent side has
        // already timed out (it deletes ITS entry and proceeds as rejected).
        entry.resolve({ requestId: id, status: "expired", byUser: "system" });
      }
    }
  }

  /** List all pending (non-expired) approval requests. */
  list(): ApprovalRequest[] {
    this.evictExpired();
    return [...this.queue.values()].map((q) => q.request);
  }

  /** Approve a pending request. Returns false if request not found or expired. */
  approve(requestId: string, byUser = "user"): boolean {
    this.evictExpired();
    const entry = this.queue.get(requestId);
    if (!entry) return false;
    this.queue.delete(requestId);
    entry.resolve({ requestId, status: "approved", byUser });
    return true;
  }

  /** Reject a pending request. Returns false if request not found or expired. */
  reject(requestId: string, byUser = "user"): boolean {
    this.evictExpired();
    const entry = this.queue.get(requestId);
    if (!entry) return false;
    this.queue.delete(requestId);
    entry.resolve({ requestId, status: "rejected", byUser });
    return true;
  }

  get size(): number {
    return this.queue.size;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let agentSystemInstance: AgentSystem | null = null;
let approvalQueueInstance: ApprovalQueue | null = null;
let initialized = false;
let warnedNoIntegrations = false;

export interface AgentSystemBag {
  agentSystem: AgentSystem;
  approvalQueue: ApprovalQueue;
}

/**
 * Return the lazily-created AgentSystem singleton.
 * Returns null (and logs) if the system cannot be set up.
 */
export function getAgentSystem(
  gateway: InferenceGateway,
  integrations: Pick<IntegrationsSystem, "calendar" | "todos" | "email"> | null,
  /** Feature 20: when provided, agent runs are grounded in the user profile. */
  memory: MemorySystem | null = null,
  /** Feature 18: when provided, the browser tools are registered. */
  browser: McpToolClient | null = null,
): AgentSystemBag | null {
  if (initialized) {
    if (!agentSystemInstance || !approvalQueueInstance) return null;
    return { agentSystem: agentSystemInstance, approvalQueue: approvalQueueInstance };
  }

  // No integrations (yet): do NOT latch `initialized` — a later call with real
  // integrations, or setAgentSystem(), must still be able to create the
  // singleton. (Latching here used to permanently poison the agent endpoints.)
  if (!integrations) {
    if (!warnedNoIntegrations) {
      warnedNoIntegrations = true;
      console.warn(
        "[agent] Integrations not available — agent system disabled.",
      );
    }
    return null;
  }

  initialized = true;

  try {
    const dataDir = getDataDir();

    const llm = new AgentLlm(gateway);
    const tools = buildToolRegistry(integrations, browser);
    const queue = new ApprovalQueue();

    agentSystemInstance = createAgentSystem({
      llm,
      tools,
      clock: realClock,
      dataDir,
      approvalSink: queue.sink,
      // 11-01: the cron-arming fix — without this, Scheduler.armCron()/
      // catchUp() silently no-op and NO cron trigger ever fires live.
      parseCronNext,
      // Feature 20: query-relevant profile facets ground agent runs.
      userContext: memory
        ? (goal: string) => memory.profile.getProfileContext(goal)
        : undefined,
      // 13.1 WR-06: stamp the REAL serving tier into AgentState.routeTier —
      // agentPreferCloud routes every agent LLM call to a cloud provider, so
      // checkpoints must not record "local" for cloud-served runs.
      routeTier: gateway.router.agentPrefersCloud() ? "cloud" : "local",
    });
    approvalQueueInstance = queue;

    return { agentSystem: agentSystemInstance, approvalQueue: approvalQueueInstance };
  } catch (err) {
    console.warn(
      "[agent] Could not initialize AgentSystem — agent features disabled.",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Override the singleton (used in tests). */
export function setAgentSystem(
  system: AgentSystem,
  queue: ApprovalQueue,
): void {
  agentSystemInstance = system;
  approvalQueueInstance = queue;
  initialized = true;
}

/** Reset the singleton (used in tests). */
export function resetAgentSystem(): void {
  agentSystemInstance = null;
  approvalQueueInstance = null;
  initialized = false;
  warnedNoIntegrations = false;
}
