/**
 * Tests for the ApprovalService (feature 17).
 *
 * Covers:
 *   - Action pauses for approval; approve → executes; reject → aborts
 *   - Auto-allow for read-only tool (no pending request created)
 *   - Timeout: request expires if no decision
 *   - Always-allow scoping: grant covers matching future actions
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../src/safety/approval.js";
import { AuditLog } from "../src/safety/audit.js";
import { registerToolMeta } from "../src/safety/policy.js";
import {
  makeAutoApproveSink,
  makeAutoRejectSink,
  ManualApprovalSink,
  FixedClock,
} from "../src/testing/fakes.js";
import type { ProposedAction, AllowScope } from "../src/types.js";

function makeAction(tool: string, args: Record<string, unknown> = {}): ProposedAction {
  return {
    id: `action-${Math.random().toString(36).slice(2)}`,
    runId: "run-1",
    tool,
    args,
    reasoning: "Testing",
    provenance: { derivedFromExternal: false, sources: [], injectionFlags: [] },
    proposedAt: new Date().toISOString(),
  };
}

describe("ApprovalService", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-allows a read-only tool without creating a request", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("search", { sideEffects: "read_only", reversible: true });

    const { sink, requests } = makeAutoApproveSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const service = new ApprovalService(sink, clock);

    const action = makeAction("search", { query: "test" });
    const { decision } = await service.evaluateAndMaybeRequest(action, auditLog, clock);

    expect(decision.outcome).toBe("auto_allow");
    expect(requests.length).toBe(0); // no approval request needed
    expect(service.pendingCount).toBe(0);
  });

  it("creates approval request for send_email and resolves approved", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const manualSink = new ManualApprovalSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const service = new ApprovalService(manualSink.sink, clock);

    const action = makeAction("send_email", {
      to: ["alice@example.com"],
      subject: "Test",
      body: "Hello",
    });

    // Start the evaluation (will pause awaiting approval)
    const evalPromise = service.evaluateAndMaybeRequest(action, auditLog, clock);

    // Wait a tick for the sink to be called
    await new Promise((r) => setImmediate(r));

    expect(manualSink.requests.length).toBe(1);
    const requestId = manualSink.requests[0]!.id;

    // Start waiting for decision
    const waitPromise = service.waitForDecision(action.id, clock, 5000);

    // Approve it
    manualSink.approve(requestId, "test-user");

    const [, decision] = await Promise.all([evalPromise, waitPromise]);
    expect(decision?.status).toBe("approved");
    expect(decision?.byUser).toBe("test-user");
  });

  it("reject → waitForDecision resolves with rejected", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const manualSink = new ManualApprovalSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const service = new ApprovalService(manualSink.sink, clock);

    const action = makeAction("send_email", {
      to: ["bob@example.com"],
      subject: "Rejected",
    });

    const evalPromise = service.evaluateAndMaybeRequest(action, auditLog, clock);
    await new Promise((r) => setImmediate(r));

    const requestId = manualSink.requests[0]!.id;
    const waitPromise = service.waitForDecision(action.id, clock, 5000);

    manualSink.reject(requestId, "test-user");

    const [, decision] = await Promise.all([evalPromise, waitPromise]);
    expect(decision?.status).toBe("rejected");
  });

  it("timeout: waitForDecision resolves null after timeout", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    // Sink that never resolves
    const neverSink = async () => new Promise<never>(() => {});
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const service = new ApprovalService(neverSink as any, clock);

    const action = makeAction("send_email", { to: ["c@d.com"] });

    void service.evaluateAndMaybeRequest(action, auditLog, clock);
    await new Promise((r) => setImmediate(r));

    // Very short timeout for test speed
    const decision = await service.waitForDecision(action.id, clock, 50);
    expect(decision).toBeNull();
  });

  it("always-allow grant: second identical action is auto-allowed", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const manualSink = new ManualApprovalSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const service = new ApprovalService(manualSink.sink, clock);

    // First action: approve with always-allow scope
    const action1 = makeAction("send_email", {
      to: ["alice@example.com"],
      subject: "Hello",
    });

    const evalPromise = service.evaluateAndMaybeRequest(action1, auditLog, clock);
    await new Promise((r) => setImmediate(r));

    const requestId = manualSink.requests[0]!.id;
    const scope: AllowScope = {
      tool: "send_email",
      match: "same_recipient",
      bound: { to: "alice@example.com" },
    };

    service.approve(requestId, "test-user", auditLog, scope);
    await evalPromise;

    // Second identical action: should be auto-allowed without a new request
    const action2 = makeAction("send_email", {
      to: "alice@example.com",
      subject: "Follow-up",
    });
    const { decision: decision2 } = await service.evaluateAndMaybeRequest(
      action2,
      auditLog,
      clock,
    );

    expect(decision2.outcome).toBe("auto_allow");
    // Only 1 request was ever created (for the first action)
    expect(manualSink.requests.length).toBe(1);
  });
});
