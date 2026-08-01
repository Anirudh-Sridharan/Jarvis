/**
 * Tests for AgentRunner checkpoint/resume semantics (feature 16).
 *
 * Covers the safety-critical resume invariants:
 *   - The checkpoint saved after step i completes carries currentStep = i+1,
 *     so resume never re-executes a completed (possibly side-effecting) step.
 *   - Resume starts from the persisted currentStep.
 *   - A terminal checkpoint (done/error) is returned as-is, never re-executed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner } from "../src/core/agent.js";
import { Checkpointer } from "../src/core/checkpointer.js";
import { ApprovalService } from "../src/safety/approval.js";
import { AuditLog } from "../src/safety/audit.js";
import {
  FakeLlm,
  FakeSearchTool,
  makeToolRegistry,
  makeAutoApproveSink,
  FixedClock,
} from "../src/testing/fakes.js";
import type { AgentState } from "../src/types.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-test-"));
}

function makeRunner(tmpDir: string, llm: FakeLlm, search = new FakeSearchTool()) {
  const tools = makeToolRegistry([search]);
  const clock = new FixedClock(Date.now());
  const { sink } = makeAutoApproveSink();
  const auditLog = new AuditLog(tmpDir, clock);
  const approvalService = new ApprovalService(sink, clock);
  const checkpointer = new Checkpointer(tmpDir);
  const runner = new AgentRunner({
    llm,
    tools,
    checkpointer,
    approvalService,
    auditLog,
    clock,
  });
  return { runner, checkpointer, search };
}

function makeMidRunState(plan: string[], currentStep: number): AgentState {
  return {
    goal: "multi step goal",
    plan,
    currentStep,
    scratchpad: [],
    observations: [],
    stepCount: 0,
    validationRetries: 0,
    reflections: [],
    routeTier: "local",
    status: "running",
  };
}

describe("AgentRunner checkpoint/resume", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps the injected routeTier into new run state so checkpoints record the real serving tier (13.1 WR-06)', async () => {
    tmpDir = makeTempDir();

    const llm = new FakeLlm().setScript([
      '{"tool": "search", "args": {"query": "one"}}',
      '{"tool": "__done__", "args": {"result": "done"}}',
    ]);
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const clock = new FixedClock(Date.now());
    const { sink } = makeAutoApproveSink();
    const runner = new AgentRunner({
      llm,
      tools,
      checkpointer: new Checkpointer(tmpDir),
      approvalService: new ApprovalService(sink, clock),
      auditLog: new AuditLog(tmpDir, clock),
      clock,
      routeTier: "cloud",
    });

    const result = await runner.run("search something", { runId: "run-tier" });
    expect(result.state.routeTier).toBe("cloud");
  });

  it("post-step checkpoint advances currentStep past the completed step", async () => {
    tmpDir = makeTempDir();

    const llm = new FakeLlm().setScript([
      // plan (goal contains "then" → non-trivial → LLM planning)
      "1. search step one\n2. search step two",
      // step 1
      '{"tool": "search", "args": {"query": "one"}}',
      '{"tool": "__done__", "args": {"result": "one done"}}',
      // step 2
      '{"tool": "search", "args": {"query": "two"}}',
      '{"tool": "__done__", "args": {"result": "two done"}}',
    ]);

    const { runner, checkpointer } = makeRunner(tmpDir, llm);
    const result = await runner.run("first search one then search two", {
      runId: "run-advance",
    });
    expect(result.run.status).toBe("done");

    const checkpoints = checkpointer.list("run-advance");
    // seq 0 = initial (currentStep 0), seq 1 = after step 1, seq 2 = after step 2
    expect(checkpoints.length).toBe(3);
    // THE FIX: the checkpoint written after step 1 completed must point at
    // step 2 — not back at step 1 (which a resume would then re-execute).
    expect(checkpoints[1]!.state.currentStep).toBe(1);
    expect(checkpoints[2]!.state.currentStep).toBe(2);
    // Mid-plan checkpoint must not look terminal
    expect(checkpoints[1]!.state.status).toBe("running");
  });

  it("resume starts from the persisted currentStep — completed steps are not re-executed", async () => {
    tmpDir = makeTempDir();

    // Simulate a run interrupted after step 1 of 2 (checkpoint as the fixed
    // post-step save would write it: currentStep advanced to 1).
    const llm = new FakeLlm().setScript([
      '{"tool": "search", "args": {"query": "two"}}',
      '{"tool": "__done__", "args": {"result": "two done"}}',
    ]);
    const search = new FakeSearchTool();
    const { runner, checkpointer } = makeRunner(tmpDir, llm, search);

    checkpointer.save(
      "run-resume",
      1,
      makeMidRunState(["search step one", "search step two"], 1),
    );

    const result = await runner.run("ignored — resumes from checkpoint", {
      runId: "run-resume",
    });

    expect(result.run.status).toBe("done");
    // Only step 2's tool call happened; step 1 was NOT replayed.
    expect(search.callLog.length).toBe(1);
    expect(search.callLog[0]!.query).toBe("two");
  });

  it("terminal checkpoint (done) returns immediately without re-executing", async () => {
    tmpDir = makeTempDir();

    const llm = new FakeLlm(); // any LLM call would be a failure signal
    const search = new FakeSearchTool();
    const { runner, checkpointer } = makeRunner(tmpDir, llm, search);

    const doneState: AgentState = {
      ...makeMidRunState(["only step"], 1),
      status: "done",
      observations: [
        {
          id: "obs-1",
          toolCallId: "done",
          ok: true,
          result: "already finished",
          latencyMs: 0,
          truncated: false,
        },
      ],
    };
    checkpointer.save("run-done", 1, doneState);

    const result = await runner.run("ignored", { runId: "run-done" });

    expect(result.run.status).toBe("done");
    expect(result.run.result).toBe("already finished");
    // No model calls, no tool calls — nothing was re-executed.
    expect(llm.callLog.length).toBe(0);
    expect(search.callLog.length).toBe(0);
  });

  it("terminal checkpoint (error) returns immediately without re-executing", async () => {
    tmpDir = makeTempDir();

    const llm = new FakeLlm();
    const search = new FakeSearchTool();
    const { runner, checkpointer } = makeRunner(tmpDir, llm, search);

    const errorState: AgentState = {
      ...makeMidRunState(["step a", "step b"], 0),
      status: "error",
    };
    checkpointer.save("run-error", 1, errorState);

    const result = await runner.run("ignored", { runId: "run-error" });

    expect(result.run.status).toBe("error");
    expect(llm.callLog.length).toBe(0);
    expect(search.callLog.length).toBe(0);
  });
});
