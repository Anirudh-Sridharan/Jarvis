/**
 * ApprovalService — manages the lifecycle of ApprovalRequests (feature 17).
 *
 * Flow:
 *   1. evaluateAndMaybeRequest(): classify the action; if auto_allow, return immediately.
 *      If require_approval, create a request, notify via sink, register a waitable.
 *   2. waitForDecision(): returns a promise that resolves when the user decides
 *      (or times out). Handles the race where the sink resolves before waitForDecision
 *      is called (earlyDecisions map).
 *   3. approve() / reject(): called externally (by tests or the UI bridge).
 *   4. Always-allow scoping: a decision can come with an AllowScope that pre-approves
 *      future matching actions.
 *
 * NOTE(future): In LangGraph.js, step 2 is replaced by interrupt() + Command(resume=...).
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ProposedAction,
  PolicyDecision,
  ApprovalRequest,
  ApprovalDecision,
  AllowScope,
  ApprovalSink,
  Clock,
} from "../types.js";
import { classifyAndDecide, getToolMeta } from "./policy.js";
import type { AuditLog } from "./audit.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Canonical JSON serialization: object keys sorted at EVERY depth, so that
 * semantically identical args always serialize (and hash) identically, and
 * nested values are fully covered. (A JSON.stringify array-replacer whitelists
 * keys at every depth and silently drops nested objects — do not use it here.)
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"; // undefined → "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

interface PendingEntry {
  request: ApprovalRequest;
  actionId: string;
  resolve: ((d: ApprovalDecision | null) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  // If sink resolved before waitForDecision was called, store here
  earlyDecision: ApprovalDecision | null;
  // The audit log that requested this approval — used for the expiry record.
  auditLog: AuditLog;
}

export class ApprovalService {
  // Keyed by requestId
  private pending = new Map<string, PendingEntry>();

  // Index: actionId → requestId
  private actionToRequest = new Map<string, string>();

  // Always-allow grants
  private grants: AllowScope[] = [];

  constructor(
    private sink: ApprovalSink,
    private clock: Clock,
  ) {}

  /**
   * Classify action + create approval request if needed.
   */
  async evaluateAndMaybeRequest(
    action: ProposedAction,
    auditLog: AuditLog,
    clock: Clock,
  ): Promise<{ decision: PolicyDecision; requestId?: string }> {
    const toolMeta = getToolMeta(action.tool);
    const decision = classifyAndDecide(action, toolMeta, clock);

    auditLog.append({
      kind: "classified",
      actionId: action.id,
      runId: action.runId,
      payload: {
        riskClass: decision.riskClass,
        outcome: decision.outcome,
        reasons: decision.reasons,
        triggeredRules: decision.triggeredRules,
        injectionFlags: action.provenance.injectionFlags,
        derivedFromExternal: action.provenance.derivedFromExternal,
      },
    });

    if (decision.outcome === "block") {
      auditLog.append({
        kind: "blocked",
        actionId: action.id,
        runId: action.runId,
        payload: { reasons: decision.reasons },
      });
      return { decision };
    }

    if (decision.outcome === "auto_allow") {
      auditLog.append({
        kind: "decided",
        actionId: action.id,
        runId: action.runId,
        payload: { outcome: "auto_allow" },
      });
      return { decision };
    }

    // Check always-allow grants
    const grant = this.matchGrant(action);
    if (grant) {
      auditLog.append({
        kind: "decided",
        actionId: action.id,
        runId: action.runId,
        payload: { outcome: "auto_allow", grant },
      });
      return {
        decision: { ...decision, outcome: "auto_allow" },
      };
    }

    // require_approval: create request
    const requestId = randomUUID();
    const expiresAt = new Date(
      clock.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
    ).toISOString();

    const request: ApprovalRequest = {
      id: requestId,
      actionId: action.id,
      runId: action.runId,
      riskClass: decision.riskClass,
      summary: buildSummary(action, decision),
      args: action.args,
      reasoning: action.reasoning,
      argsHash: hashArgs(action.args),
      status: "pending",
      createdAt: clock.isoNow(),
      expiresAt,
    };

    auditLog.append({
      kind: "requested",
      actionId: action.id,
      runId: action.runId,
      payload: { requestId, summary: request.summary },
    });

    // Register pending entry BEFORE calling sink
    const entry: PendingEntry = {
      request,
      actionId: action.id,
      resolve: null,
      timer: null,
      earlyDecision: null,
      auditLog,
    };
    this.pending.set(requestId, entry);
    this.actionToRequest.set(action.id, requestId);

    // Fire the sink; when it resolves, deliver the decision
    void this.sink(request).then((d) => {
      this._deliverDecision(requestId, d, auditLog);
    }).catch(() => {
      this._deliverDecision(requestId, { requestId, status: "expired", byUser: "system" }, auditLog);
    });

    return { decision, requestId };
  }

  /**
   * Wait for a pending approval decision by actionId.
   * Resolves when approved/rejected/expired, or null on timeout.
   */
  async waitForDecision(
    actionId: string,
    _clock: Clock,
    timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  ): Promise<ApprovalDecision | null> {
    const requestId = this.actionToRequest.get(actionId);
    if (!requestId) return null;

    const entry = this.pending.get(requestId);
    if (!entry) return null;

    // If the sink already resolved before we got here, return immediately
    if (entry.earlyDecision !== null) {
      const d = entry.earlyDecision;
      this.pending.delete(requestId);
      this.actionToRequest.delete(actionId);
      return d;
    }

    // Otherwise wait for the sink to resolve
    return new Promise<ApprovalDecision | null>((resolve) => {
      entry.resolve = resolve;
      entry.timer = setTimeout(() => {
        entry.resolve = null;
        // Mark the request expired and record it in the audit log —
        // a silent timeout must leave a tamper-evident trace.
        entry.request.status = "expired";
        entry.request.resolvedAt = this.clock.isoNow();
        entry.auditLog.append({
          kind: "expired",
          actionId: entry.actionId,
          runId: entry.request.runId,
          payload: { requestId, reason: "approval timeout" },
        });
        this.pending.delete(requestId);
        this.actionToRequest.delete(actionId);
        resolve(null);
      }, timeoutMs);
    });
  }

  /**
   * Approve a pending request. Called by the UI bridge or test.
   */
  approve(
    requestId: string,
    byUser: string,
    auditLog: AuditLog,
    alwaysAllow?: AllowScope,
  ): void {
    // Only register an always-allow grant for a request that is actually
    // pending — a bogus/expired requestId must never mint a standing grant.
    const entry = this.pending.get(requestId);
    if (!entry || entry.request.status !== "pending") return;
    if (alwaysAllow) {
      this.grants.push(alwaysAllow);
    }
    const decision: ApprovalDecision = {
      requestId,
      status: "approved",
      byUser,
      alwaysAllow,
    };
    this._deliverDecision(requestId, decision, auditLog);
  }

  /**
   * Reject a pending request.
   */
  reject(requestId: string, byUser: string, auditLog: AuditLog): void {
    const decision: ApprovalDecision = {
      requestId,
      status: "rejected",
      byUser,
    };
    this._deliverDecision(requestId, decision, auditLog);
  }

  private _deliverDecision(
    requestId: string,
    decision: ApprovalDecision,
    auditLog: AuditLog,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    const kind =
      decision.status === "approved"
        ? ("approved" as const)
        : decision.status === "rejected"
          ? ("rejected" as const)
          : ("expired" as const);

    auditLog.append({
      kind,
      actionId: entry.actionId,
      runId: entry.request.runId,
      payload: { requestId, byUser: decision.byUser },
    });

    if (entry.resolve !== null) {
      // waitForDecision is already waiting — deliver immediately
      if (entry.timer !== null) clearTimeout(entry.timer);
      const resolve = entry.resolve;
      this.pending.delete(requestId);
      this.actionToRequest.delete(entry.actionId);
      resolve(decision);
    } else {
      // waitForDecision hasn't been called yet — store as early decision
      entry.earlyDecision = decision;
    }
  }

  private matchGrant(action: ProposedAction): AllowScope | undefined {
    const now = this.clock.isoNow();
    return this.grants.find((g) => {
      if (g.tool !== action.tool) return false;
      if (g.expiresAt && g.expiresAt < now) return false;
      if (g.match === "any") return true;
      if (g.match === "exact_args" && g.bound) {
        // Full-object canonical comparison: extra keys in the new action's
        // args (bcc, attachments, …) must NOT match a narrower grant.
        return canonicalJson(action.args) === canonicalJson(g.bound);
      }
      if (g.match === "same_recipient" && g.bound?.["to"]) {
        const recipient = action.args["to"];
        return recipient === g.bound["to"];
      }
      return false;
    });
  }

  /** Number of pending requests. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Expose pending request by id (for tests). */
  getPendingRequest(requestId: string): ApprovalRequest | undefined {
    return this.pending.get(requestId)?.request;
  }

  /** List all pending request ids. */
  listPendingIds(): string[] {
    return [...this.pending.keys()];
  }
}

function buildSummary(action: ProposedAction, decision: PolicyDecision): string {
  return `[${decision.riskClass}] ${action.tool}(${JSON.stringify(action.args).slice(0, 100)})`;
}
