/**
 * agent-integration.test.ts
 *
 * Verifies that @jarvis/agent is correctly wired into @jarvis/core:
 *   1. A read-only tool goal runs without approval.
 *   2. email_send pauses for approval; approving via queue lets it proceed.
 *   3. Rejecting email_send aborts the tool call.
 *   4. calendar_create_event pauses for approval similarly.
 *   5. The proactive nightly trigger calls memory.consolidation.run (spy).
 *   6. Audit chain verifies after a run.
 *   7. /approvals, /agent, /audit endpoints return sane shapes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";

import {
  FakeLlm,
  FixedClock,
  makeAutoApproveSink,
  makeAutoRejectSink,
  ManualApprovalSink,
} from "@jarvis/agent/testing";
import { createAgentSystem, registerToolMeta } from "@jarvis/agent";
import type { Tool, ToolRegistry } from "@jarvis/agent";

import {
  ApprovalQueue,
  setAgentSystem,
  resetAgentSystem,
} from "../src/agent/agentSystem.js";
import {
  registerProactiveTriggers,
  resetProactiveBootstrap,
} from "../src/agent/proactiveBootstrap.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-agent-integration-test-"));
}

function makeReadOnlyTool(name: string): Tool & { callLog: unknown[] } {
  const callLog: unknown[] = [];
  const tool: Tool & { callLog: unknown[] } = {
    name,
    description: `Fake read-only tool: ${name}`,
    schema: z.object({ query: z.string() }),
    readOnly: true,
    callLog,
    async run(args: unknown): Promise<unknown> {
      callLog.push(args);
      return { result: `read-only result for ${name}` };
    },
  };
  return tool;
}

function makeWriteTool(name: string): Tool & { callLog: unknown[] } {
  const callLog: unknown[] = [];
  const tool: Tool & { callLog: unknown[] } = {
    name,
    description: `Fake write tool: ${name}`,
    schema: z.object({ payload: z.string() }),
    readOnly: false,
    callLog,
    async run(args: unknown): Promise<unknown> {
      callLog.push(args);
      return { ok: true, tool: name };
    },
  };
  return tool;
}

function makeToolRegistry(tools: Tool[]): ToolRegistry {
  return new Map(tools.map((t) => [t.name, t]));
}

/**
 * FakeLlm scripted to: call a specific tool once, then emit __done__.
 */
function scriptedLlm(toolName: string, args: Record<string, unknown>): FakeLlm {
  return new FakeLlm()
    .setScript([
      JSON.stringify({ tool: toolName, args }),
      JSON.stringify({ tool: "__done__", args: { result: "completed" } }),
    ]);
}

/**
 * Build a minimal Hono app with the agent endpoints, backed by the injected
 * agentBag. Mirrors server.ts endpoint logic to keep tests self-contained.
 */
function buildAgentTestApp(
  agentBag: ReturnType<typeof import("../src/agent/agentSystem.js").getAgentSystem>,
) {
  const app = new Hono();

  app.get("/approvals", (c) => {
    if (!agentBag) return c.json({ ok: false, error: "no agent" }, 503);
    return c.json({ ok: true, pending: agentBag.approvalQueue.list() });
  });

  app.post("/approvals/:id/approve", (c) => {
    if (!agentBag) return c.json({ ok: false, error: "no agent" }, 503);
    const requestId = c.req.param("id");
    const ok = agentBag.approvalQueue.approve(requestId, "test-user");
    if (!ok) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, requestId, status: "approved" });
  });

  app.post("/approvals/:id/reject", (c) => {
    if (!agentBag) return c.json({ ok: false, error: "no agent" }, 503);
    const requestId = c.req.param("id");
    const ok = agentBag.approvalQueue.reject(requestId, "test-user");
    if (!ok) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, requestId, status: "rejected" });
  });

  app.get("/audit", (c) => {
    if (!agentBag) return c.json({ ok: false, error: "no agent" }, 503);
    const verify = agentBag.agentSystem.audit.verifyChain();
    const count = agentBag.agentSystem.audit.count;
    return c.json({ ok: true, count, chainValid: verify.ok, brokenAt: verify.brokenAt ?? null });
  });

  return app;
}

// ── Helper: fetch from Hono app ───────────────────────────────────────────────

async function getJson(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://localhost${path}`);
  const res = await app.fetch(req);
  return { status: res.status, body: await res.json() as unknown };
}

async function postJson(
  app: Hono,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await app.fetch(req);
  return { status: res.status, body: await res.json() as unknown };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agent-integration: read-only tool runs without approval", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetAgentSystem();
  });

  it("a goal that calls a read-only tool auto-approves and completes", async () => {
    tmpDir = makeTempDir();

    const readTool = makeReadOnlyTool("fake_read");
    registerToolMeta("fake_read", { sideEffects: "read_only", reversible: true });

    const llm = scriptedLlm("fake_read", { query: "test query" });
    const tools = makeToolRegistry([readTool]);
    const clock = new FixedClock(Date.now());

    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    const result = await agentSystem.agent.run("find some information", { source: "manual" });

    // Run should complete without approval needed
    expect(result.run.status).toBe("done");
    // No pending approvals in queue
    expect(queue.size).toBe(0);
    // The read-only tool was called
    expect(readTool.callLog.length).toBeGreaterThanOrEqual(1);
  });
});

describe("agent-integration: email_send requires and awaits approval", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetAgentSystem();
  });

  it("approving email_send via queue lets the run proceed to done", async () => {
    tmpDir = makeTempDir();

    const emailTool = makeWriteTool("email_send");
    // Register the tool as outward_comm so policy requires approval
    registerToolMeta("email_send", { sideEffects: "outward_comm", reversible: false });

    const llm = new FakeLlm()
      .setScript([
        // First call: emit email_send
        JSON.stringify({
          tool: "email_send",
          args: { payload: "Hello from agent" },
        }),
        // After approval, agent reflects and finishes
        JSON.stringify({ tool: "__done__", args: { result: "email sent" } }),
      ]);

    const tools = makeToolRegistry([emailTool]);
    const clock = new FixedClock(Date.now());
    const manualSink = new ManualApprovalSink();

    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: manualSink.sink,
    });

    // Start the run (will pause awaiting approval)
    const runPromise = agentSystem.agent.run("send an email", { source: "manual" });

    // Wait for the approval request to arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(manualSink.requests.length).toBeGreaterThanOrEqual(1);

    // Approve it
    const requestId = manualSink.requests[0]!.id;
    manualSink.approve(requestId, "test-user");

    const result = await runPromise;

    // Run should complete (approved or done)
    expect(["done", "running", "error"]).toContain(result.run.status);
    // Email tool was called after approval
    expect(emailTool.callLog.length).toBeGreaterThanOrEqual(1);
  });

  it("rejecting email_send via queue aborts the tool and run returns error/done", async () => {
    tmpDir = makeTempDir();

    const emailTool = makeWriteTool("email_send");
    registerToolMeta("email_send", { sideEffects: "outward_comm", reversible: false });

    const llm = new FakeLlm()
      .setScript([
        JSON.stringify({
          tool: "email_send",
          args: { payload: "rejected email" },
        }),
        // After rejection the agent reflects
        JSON.stringify({ tool: "__done__", args: { result: "aborted" } }),
        JSON.stringify({ tool: "__done__", args: { result: "aborted" } }),
        JSON.stringify({ tool: "__done__", args: { result: "aborted" } }),
      ]);

    const tools = makeToolRegistry([emailTool]);
    const clock = new FixedClock(Date.now());
    const manualSink = new ManualApprovalSink();

    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: manualSink.sink,
    });

    const runPromise = agentSystem.agent.run("send an email", { source: "manual" });

    // Wait for the approval request
    await new Promise((r) => setTimeout(r, 50));
    expect(manualSink.requests.length).toBeGreaterThanOrEqual(1);

    // Reject it
    const requestId = manualSink.requests[0]!.id;
    manualSink.reject(requestId, "test-user");

    const result = await runPromise;

    // Run should complete (with done or error status)
    expect(["done", "error"]).toContain(result.run.status);
    // Email tool was NOT executed (approval was rejected)
    expect(emailTool.callLog.length).toBe(0);
  });
});

describe("agent-integration: calendar_create_event requires approval", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetAgentSystem();
  });

  it("calendar_create_event pauses for approval", async () => {
    tmpDir = makeTempDir();

    const calTool = makeWriteTool("calendar_create_event");
    registerToolMeta("calendar_create_event", {
      sideEffects: "calendar_write",
      reversible: true,
    });

    const llm = new FakeLlm()
      .setScript([
        JSON.stringify({
          tool: "calendar_create_event",
          args: { payload: "schedule meeting" },
        }),
        JSON.stringify({ tool: "__done__", args: { result: "scheduled" } }),
        JSON.stringify({ tool: "__done__", args: { result: "scheduled" } }),
      ]);

    const tools = makeToolRegistry([calTool]);
    const clock = new FixedClock(Date.now());
    const { sink, requests } = makeAutoApproveSink("test-user");

    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: sink,
    });

    const result = await agentSystem.agent.run("schedule a meeting", { source: "manual" });

    // Approval was requested (calendar_write is not auto-allowed)
    expect(requests.length).toBeGreaterThanOrEqual(1);
    // Run completed after auto-approval
    expect(["done", "error"]).toContain(result.run.status);
  });
});

describe("agent-integration: ApprovalQueue in-memory queue", () => {
  it("queue.list() returns pending approvals", async () => {
    const queue = new ApprovalQueue();

    let resolve1: ((d: import("@jarvis/agent").ApprovalDecision) => void) | undefined;

    // Simulate a pending approval
    const sinkPromise = queue.sink({
      id: "req-1",
      actionId: "action-1",
      runId: "run-1",
      riskClass: "outward_comm",
      summary: "send email",
      args: { to: ["test@example.com"] },
      reasoning: "test",
      argsHash: "abc123",
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await new Promise((r) => setTimeout(r, 10));

    const pending = queue.list();
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe("req-1");

    // Approve it
    const approved = queue.approve("req-1", "test-user");
    expect(approved).toBe(true);

    const decision = await sinkPromise;
    expect(decision.status).toBe("approved");
    expect(decision.byUser).toBe("test-user");

    // Queue is now empty
    expect(queue.list().length).toBe(0);
  });

  it("expired entries are evicted: list() omits them, approve()/reject() return false", async () => {
    const queue = new ApprovalQueue();

    // Entry whose agent-side approval window already closed.
    const sinkPromise = queue.sink({
      id: "req-expired",
      actionId: "action-x",
      runId: "run-x",
      riskClass: "outward_comm",
      summary: "expired email",
      args: {},
      reasoning: "test",
      argsHash: "exp1",
      status: "pending",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // already past
    });

    await new Promise((r) => setTimeout(r, 10));

    // list() must not surface a dead approval the agent already timed out on.
    expect(queue.list()).toHaveLength(0);
    // Approving/rejecting an expired action must be a 404-shaped false, not
    // a fake ok:true for something that will never execute.
    expect(queue.approve("req-expired", "test-user")).toBe(false);
    expect(queue.reject("req-expired", "test-user")).toBe(false);

    // Eviction settles the sink promise as expired (no leaked promise).
    const decision = await sinkPromise;
    expect(decision.status).toBe("expired");
  });

  it("non-expired entries survive eviction and can still be approved", async () => {
    const queue = new ApprovalQueue();

    void queue.sink({
      id: "req-live",
      actionId: "action-y",
      runId: "run-y",
      riskClass: "outward_comm",
      summary: "live email",
      args: {},
      reasoning: "test",
      argsHash: "live1",
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(queue.list()).toHaveLength(1);
    expect(queue.approve("req-live", "test-user")).toBe(true);
  });

  it("queue.reject() resolves with rejected status", async () => {
    const queue = new ApprovalQueue();

    const sinkPromise = queue.sink({
      id: "req-2",
      actionId: "action-2",
      runId: "run-2",
      riskClass: "outward_comm",
      summary: "send email 2",
      args: {},
      reasoning: "test",
      argsHash: "def456",
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await new Promise((r) => setTimeout(r, 10));
    queue.reject("req-2", "test-user");

    const decision = await sinkPromise;
    expect(decision.status).toBe("rejected");
  });
});

describe("agent-integration: HTTP endpoints return sane shapes", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetAgentSystem();
  });

  it("GET /approvals returns ok:true with pending array", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    const agentBag = { agentSystem, approvalQueue: queue };
    const app = buildAgentTestApp(agentBag);

    const { status, body } = await getJson(app, "/approvals");
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b["ok"]).toBe(true);
    expect(Array.isArray(b["pending"])).toBe(true);
  });

  it("POST /approvals/:id/approve returns ok:true for existing request", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();

    // Add a fake pending request
    void queue.sink({
      id: "req-test",
      actionId: "action-test",
      runId: "run-test",
      riskClass: "outward_comm",
      summary: "test",
      args: {},
      reasoning: "test",
      argsHash: "000",
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await new Promise((r) => setTimeout(r, 10));

    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    const agentBag = { agentSystem, approvalQueue: queue };
    const app = buildAgentTestApp(agentBag);

    const { status, body } = await postJson(app, "/approvals/req-test/approve");
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b["ok"]).toBe(true);
    expect(b["status"]).toBe("approved");
  });

  it("POST /approvals/:id/reject returns 404 for unknown request", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    const agentBag = { agentSystem, approvalQueue: queue };
    const app = buildAgentTestApp(agentBag);

    const { status, body } = await postJson(app, "/approvals/nonexistent/reject");
    expect(status).toBe(404);
    const b = body as Record<string, unknown>;
    expect(b["ok"]).toBe(false);
  });

  it("GET /audit returns ok:true with count and chainValid", async () => {
    tmpDir = makeTempDir();

    const readTool = makeReadOnlyTool("test_read");
    registerToolMeta("test_read", { sideEffects: "read_only", reversible: true });

    const llm = scriptedLlm("test_read", { query: "audit test" });
    const tools = makeToolRegistry([readTool]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    // Run an agent goal to populate the audit log
    await agentSystem.agent.run("run an audit test", { source: "manual" });

    const agentBag = { agentSystem, approvalQueue: queue };
    const app = buildAgentTestApp(agentBag);

    const { status, body } = await getJson(app, "/audit");
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b["ok"]).toBe(true);
    expect(typeof b["count"]).toBe("number");
    expect((b["count"] as number)).toBeGreaterThan(0);
    expect(b["chainValid"]).toBe(true);
  });
});

describe("agent-integration: audit chain verifies after a run", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetAgentSystem();
  });

  it("audit.verifyChain() returns ok:true after a run with a read-only tool", async () => {
    tmpDir = makeTempDir();

    const readTool = makeReadOnlyTool("verify_read_tool");
    registerToolMeta("verify_read_tool", { sideEffects: "read_only", reversible: true });

    const llm = scriptedLlm("verify_read_tool", { query: "chain verification test" });
    const tools = makeToolRegistry([readTool]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm,
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    await agentSystem.agent.run("verify audit chain", { source: "manual" });

    const result = agentSystem.audit.verifyChain();
    expect(result.ok).toBe(true);
    expect(result.brokenAt).toBeUndefined();
  });
});

describe("agent-integration: proactive triggers call memory.consolidation.run", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetAgentSystem();
    resetProactiveBootstrap();
  });

  it("nightly-consolidation trigger calls memory.consolidation.run when fired", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    // Create fake memory and integrations
    const consolidationRunSpy = vi.fn().mockResolvedValue({
      status: "ok",
      extracted: 0,
      insights: 0,
      forgotten: 0,
      duration: 100,
    });

    const fakeMemory = {
      consolidation: {
        run: consolidationRunSpy,
      },
    };

    const fakeBriefingDoc = {
      id: "brief-1",
      date: "2026-06-09",
      context: { date: "2026-06-09", sleep: null, agenda: null, todos: null, insights: null },
      generatedBy: "template" as const,
      status: "ready" as const,
      createdAt: new Date().toISOString(),
      markdown: "# Good morning",
    };

    const fakeIntegrations = {
      briefing: {
        assembleBriefing: vi.fn().mockResolvedValue(fakeBriefingDoc),
      },
      metrics: agentSystem.triggers as never, // Not needed for this test
    };

    const { consolidationTriggerId } = registerProactiveTriggers({
      agentSystem,
      integrations: fakeIntegrations as never,
      memory: fakeMemory,
    });

    // Manually fire the nightly-consolidation trigger
    const run = await agentSystem.triggers.fireTrigger(consolidationTriggerId, "manual");

    expect(run.status).toMatch(/done|running|awaiting-approval/);
    expect(consolidationRunSpy).toHaveBeenCalledOnce();
    expect(consolidationRunSpy).toHaveBeenCalledWith("scheduler");
  });

  it("morning-briefing trigger calls integrations.briefing.assembleBriefing when fired", async () => {
    tmpDir = makeTempDir();

    const tools = makeToolRegistry([]);
    const clock = new FixedClock(Date.now());
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools,
      clock,
      dataDir: tmpDir,
      approvalSink: queue.sink,
    });

    const assembleBriefingSpy = vi.fn().mockResolvedValue({
      id: "brief-2",
      date: "2026-06-09",
      context: { date: "2026-06-09", sleep: null, agenda: null, todos: null, insights: null },
      generatedBy: "template" as const,
      status: "ready" as const,
      createdAt: new Date().toISOString(),
      markdown: "# Morning briefing",
    });

    const fakeIntegrations = {
      briefing: { assembleBriefing: assembleBriefingSpy },
      metrics: {} as never,
    };

    const fakeMemory = {
      consolidation: {
        run: vi.fn().mockResolvedValue({ status: "ok", extracted: 0, insights: 0, forgotten: 0, duration: 0 }),
      },
    };

    const { briefingTriggerId } = registerProactiveTriggers({
      agentSystem,
      integrations: fakeIntegrations as never,
      memory: fakeMemory,
    });

    // Manually fire the morning-briefing trigger
    const run = await agentSystem.triggers.fireTrigger(briefingTriggerId, "manual");

    expect(run.status).toMatch(/done|running/);
    expect(assembleBriefingSpy).toHaveBeenCalledOnce();
  });
});
