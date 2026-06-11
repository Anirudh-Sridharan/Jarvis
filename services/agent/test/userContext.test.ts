/**
 * Feature 20 — agent runs are grounded in user-profile context.
 *
 * The provider is injected (leaf package never imports memory); the runner
 * resolves it once per run, threads it into the planner prompt and every
 * harness tool-call prompt, and degrades silently when it throws.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner } from "../src/core/agent.js";
import { Checkpointer } from "../src/core/checkpointer.js";
import { ApprovalService } from "../src/safety/approval.js";
import { AuditLog } from "../src/safety/audit.js";
import { buildToolCallPrompt } from "../src/core/harness.js";
import {
  FakeLlm,
  FakeSearchTool,
  makeToolRegistry,
  makeAutoApproveSink,
  FixedClock,
} from "../src/testing/fakes.js";
import type { UserContextProvider } from "../src/types.js";

function makeRunner(
  tmpDir: string,
  llm: FakeLlm,
  userContext?: UserContextProvider,
) {
  const tools = makeToolRegistry([new FakeSearchTool()]);
  const clock = new FixedClock(Date.now());
  const { sink } = makeAutoApproveSink();
  return new AgentRunner({
    llm,
    tools,
    checkpointer: new Checkpointer(tmpDir),
    approvalService: new ApprovalService(sink, clock),
    auditLog: new AuditLog(tmpDir, clock),
    clock,
    userContext,
  });
}

describe("buildToolCallPrompt user context", () => {
  it("includes the user context section when provided", () => {
    const prompt = buildToolCallPrompt("book lunch", [], [], "- Preference: vegetarian");
    expect(prompt).toContain("User context:");
    expect(prompt).toContain("vegetarian");
  });

  it("omits the section when absent", () => {
    expect(buildToolCallPrompt("book lunch", [], [])).not.toContain("User context:");
  });
});

describe("AgentRunner user context", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("threads the provider's output into the react-loop prompts", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-ucx-test-"));
    const llm = new FakeLlm(); // default: immediate __done__
    const runner = makeRunner(tmpDir, llm, (goal) => {
      expect(goal).toBe("say hello");
      return "- Preference: vegetarian lunches";
    });

    const result = await runner.run("say hello", { runId: "run-ucx-1" });
    expect(result.run.status).toBe("done");
    expect(llm.callLog.some((p) => p.includes("vegetarian lunches"))).toBe(true);
  });

  it("a throwing provider degrades to no context and the run still completes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-ucx-test-"));
    const llm = new FakeLlm();
    const runner = makeRunner(tmpDir, llm, () => {
      throw new Error("profile unavailable");
    });

    const result = await runner.run("say hello", { runId: "run-ucx-2" });
    expect(result.run.status).toBe("done");
    expect(llm.callLog.some((p) => p.includes("User context:"))).toBe(false);
  });

  it("oversized context is truncated to the cap", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-ucx-test-"));
    const llm = new FakeLlm();
    const huge = "v".repeat(5_000);
    const runner = makeRunner(tmpDir, llm, () => huge);

    const result = await runner.run("say hello", { runId: "run-ucx-3" });
    expect(result.run.status).toBe("done");
    const withCtx = llm.callLog.find((p) => p.includes("User context:"));
    expect(withCtx).toBeDefined();
    // The injected block must be capped well below the raw 5k payload.
    expect(withCtx!.length).toBeLessThan(3_000);
  });
});
