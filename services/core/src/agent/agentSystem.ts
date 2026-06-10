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
import type { InferenceGateway } from "../inference/gateway.js";
import { AgentLlm } from "./agentLlm.js";
import { buildToolRegistry } from "./tools/index.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Real clock ────────────────────────────────────────────────────────────────

export const realClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

// ── ApprovalQueue ─────────────────────────────────────────────────────────────

export interface QueuedApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * In-memory queue of pending approval requests.
 * The HTTP endpoints read from and write to this queue.
 * The dashboard / menu-bar polls GET /approvals and calls POST /approvals/:id/approve|reject.
 */
export class ApprovalQueue {
  private queue = new Map<string, QueuedApproval>();

  /**
   * ApprovalSink — passed to createAgentSystem. Called whenever an action needs approval.
   * Returns a Promise that resolves when the user decides (or times out).
   */
  readonly sink = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    return new Promise<ApprovalDecision>((resolve) => {
      this.queue.set(request.id, { request, resolve });
    });
  };

  /** List all pending approval requests. */
  list(): ApprovalRequest[] {
    return [...this.queue.values()].map((q) => q.request);
  }

  /** Approve a pending request. Returns false if request not found. */
  approve(requestId: string, byUser = "user"): boolean {
    const entry = this.queue.get(requestId);
    if (!entry) return false;
    this.queue.delete(requestId);
    entry.resolve({ requestId, status: "approved", byUser });
    return true;
  }

  /** Reject a pending request. Returns false if request not found. */
  reject(requestId: string, byUser = "user"): boolean {
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
  integrations: Pick<IntegrationsSystem, "calendar" | "todos"> | null,
): AgentSystemBag | null {
  if (initialized) {
    if (!agentSystemInstance || !approvalQueueInstance) return null;
    return { agentSystem: agentSystemInstance, approvalQueue: approvalQueueInstance };
  }
  initialized = true;

  try {
    if (!integrations) {
      console.warn(
        "[agent] Integrations not available — agent system disabled.",
      );
      return null;
    }

    const dataDir =
      process.env["JARVIS_DATA_DIR"] ?? join(homedir(), ".jarvis", "data");

    const llm = new AgentLlm(gateway);
    const tools = buildToolRegistry(integrations);
    const queue = new ApprovalQueue();

    agentSystemInstance = createAgentSystem({
      llm,
      tools,
      clock: realClock,
      dataDir,
      approvalSink: queue.sink,
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
}
