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
import { ApprovalService, hashArgs, canonicalJson } from "../src/safety/approval.js";
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

  it("a standing grant NEVER auto-allows an injection-tainted action", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const manualSink = new ManualApprovalSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir);
    const service = new ApprovalService(manualSink.sink, clock);

    // Establish an always-allow same_recipient grant via a clean action
    const clean = makeAction("send_email", { to: "alice@example.com", subject: "Hi" });
    const evalPromise = service.evaluateAndMaybeRequest(clean, auditLog, clock);
    await new Promise((r) => setImmediate(r));
    service.approve(manualSink.requests[0]!.id, "test-user", auditLog, {
      tool: "send_email",
      match: "same_recipient",
      bound: { to: "alice@example.com" },
    });
    await evalPromise;

    // Tainted action to the SAME recipient: grant must be ignored
    const tainted = makeAction("send_email", {
      to: "alice@example.com",
      subject: "Re: invoice",
    });
    tainted.provenance = {
      derivedFromExternal: true,
      sources: ["email:msg-evil"],
      injectionFlags: ["instruction-override"],
    };

    const taintedEval = service.evaluateAndMaybeRequest(tainted, auditLog, clock);
    await new Promise((r) => setImmediate(r));

    // A NEW approval request was created (grant did not short-circuit)
    expect(manualSink.requests.length).toBe(2);
    service.reject(manualSink.requests[1]!.id, "test-user", auditLog);
    const { decision } = await taintedEval;
    expect(decision.outcome).not.toBe("auto_allow");
  });

  it("exact_args grant does NOT cover an action with extra args (bcc smuggling)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const manualSink = new ManualApprovalSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir, clock);
    const service = new ApprovalService(manualSink.sink, clock);

    const boundArgs = {
      to: ["alice@example.com"],
      subject: "Hello",
      body: "Hi Alice",
    };

    // Approve action1 with an exact_args always-allow grant
    const action1 = makeAction("send_email", boundArgs);
    const evalPromise = service.evaluateAndMaybeRequest(action1, auditLog, clock);
    await new Promise((r) => setImmediate(r));
    service.approve(manualSink.requests[0]!.id, "test-user", auditLog, {
      tool: "send_email",
      match: "exact_args",
      bound: boundArgs,
    });
    await evalPromise;

    // Same args PLUS a bcc — must NOT auto-allow on the narrower grant
    const action2 = makeAction("send_email", {
      ...boundArgs,
      bcc: ["attacker@evil.com"],
    });
    const { decision: decision2 } = await service.evaluateAndMaybeRequest(
      action2,
      auditLog,
      clock,
    );
    expect(decision2.outcome).toBe("require_approval");
    expect(manualSink.requests.length).toBe(2); // a new request was created

    // Exactly identical args DO match the grant
    const action3 = makeAction("send_email", {
      body: "Hi Alice",
      subject: "Hello",
      to: ["alice@example.com"],
    }); // key order shuffled on purpose
    const { decision: decision3 } = await service.evaluateAndMaybeRequest(
      action3,
      auditLog,
      clock,
    );
    expect(decision3.outcome).toBe("auto_allow");
    expect(manualSink.requests.length).toBe(2); // no new request
  });

  it("approve() with a bogus requestId does not register an always-allow grant", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    const manualSink = new ManualApprovalSink();
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir, clock);
    const service = new ApprovalService(manualSink.sink, clock);

    // Nothing is pending — this approve must be a no-op, including the grant.
    service.approve("nonexistent-request", "attacker", auditLog, {
      tool: "send_email",
      match: "any",
    });

    const action = makeAction("send_email", { to: ["x@y.com"], subject: "Hi" });
    const { decision } = await service.evaluateAndMaybeRequest(
      action,
      auditLog,
      clock,
    );

    // Still requires approval — no phantom "any" grant exists.
    expect(decision.outcome).toBe("require_approval");
    expect(service.pendingCount).toBe(1);
  });

  it("hashArgs canonicalizes nested objects at every depth", () => {
    // Same nested args, different key order → identical hash
    expect(hashArgs({ a: { b: 1, c: { d: 2, e: 3 } }, f: [1, 2] })).toBe(
      hashArgs({ f: [1, 2], a: { c: { e: 3, d: 2 }, b: 1 } }),
    );
    // Different NESTED values → different hash (the old array-replacer
    // serialized nested objects as {} so these collided)
    expect(hashArgs({ to: { email: "alice@example.com" } })).not.toBe(
      hashArgs({ to: { email: "attacker@evil.com" } }),
    );
    expect(canonicalJson({ b: { y: 2, x: 1 }, a: 0 })).toBe(
      '{"a":0,"b":{"x":1,"y":2}}',
    );
  });

  it("timeout marks the request expired and writes an audit entry", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("send_email", { sideEffects: "outward_comm", reversible: false });

    // Sink that never resolves
    const neverSink = async () => new Promise<never>(() => {});
    const clock = new FixedClock(Date.now());
    const auditLog = new AuditLog(tmpDir, clock);
    const service = new ApprovalService(neverSink as any, clock);

    const action = makeAction("send_email", { to: ["c@d.com"] });
    const { requestId } = await service.evaluateAndMaybeRequest(
      action,
      auditLog,
      clock,
    );
    const request = service.getPendingRequest(requestId!);

    const decision = await service.waitForDecision(action.id, clock, 50);
    expect(decision).toBeNull();

    // The request object was marked expired (not silently dropped)
    expect(request?.status).toBe("expired");
    expect(request?.resolvedAt).toBeDefined();
    expect(service.pendingCount).toBe(0);

    // And the expiry is in the audit trail
    const entries = auditLog.forRun("run-1");
    expect(entries.some((e) => e.kind === "expired")).toBe(true);
  });

  it("uses the injected clock for decidedAt and audit timestamps", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    registerToolMeta("search", { sideEffects: "read_only", reversible: true });

    const fixedMs = new Date("2026-01-02T03:04:05.000Z").getTime();
    const clock = new FixedClock(fixedMs);
    const { sink } = makeAutoApproveSink();
    const auditLog = new AuditLog(tmpDir, clock);
    const service = new ApprovalService(sink, clock);

    const action = makeAction("search", { query: "q" });
    const { decision } = await service.evaluateAndMaybeRequest(
      action,
      auditLog,
      clock,
    );

    expect(decision.decidedAt).toBe(clock.isoNow());
    const entries = auditLog.forRun("run-1");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.ts === clock.isoNow())).toBe(true);
  });
});
