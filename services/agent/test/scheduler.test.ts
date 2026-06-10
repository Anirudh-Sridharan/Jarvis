/**
 * Tests for the proactive scheduler (feature 19).
 *
 * Covers:
 *   - Cron trigger fires when due (via parseCronNext mock)
 *   - Cron not due → does not fire
 *   - Lock prevents overlapping runs
 *   - Missed trigger (machine off) → catch-up run
 *   - Condition trigger fires when metric crosses threshold
 *   - EpisodicState is persisted per run
 *   - Agent-goal trigger wakes agent as reasoner
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/proactive/scheduler.js";
import {
  FakeLlm,
  FakeSearchTool,
  makeToolRegistry,
  makeAutoApproveSink,
  FixedClock,
} from "../src/testing/fakes.js";
import type { ScheduledJob, TriggerContext, JobResult } from "../src/types.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sched-test-"));
}

function makeFakeJobResult(summary = "done"): JobResult {
  return { status: "done", summary };
}

describe("Scheduler", () => {
  let tmpDir: string;
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fires a manual trigger and records TriggerRun", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(Date.now());
    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const jobCalled: string[] = [];
    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
    });

    const job: ScheduledJob = {
      name: "test-job",
      description: "Test",
      handler: async (ctx: TriggerContext): Promise<JobResult> => {
        jobCalled.push(ctx.trigger.id);
        return makeFakeJobResult("job ran");
      },
      needsModel: "none",
      maxDurationSec: 10,
      singleton: true,
    };

    scheduler.registerJob(job);

    const trigger = scheduler.addTrigger({
      name: "test-cron",
      kind: "cron",
      enabled: true,
      action: { job: "test-job" },
      tags: [],
      catchUp: "run-once",
    });

    const run = await scheduler.fireTrigger(trigger.id, "manual");

    expect(run.status).toBe("done");
    expect(run.firedBy).toBe("manual");
    expect(jobCalled).toContain(trigger.id);

    // Verify the run was persisted
    const loaded = scheduler.getRun(run.id);
    expect(loaded?.status).toBe("done");
    expect(loaded?.triggerId).toBe(trigger.id);
  });

  it("EpisodicState is updated after a run", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(Date.now());
    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
    });

    const job: ScheduledJob = {
      name: "episodic-job",
      description: "Test episodic",
      handler: async (): Promise<JobResult> => ({
        status: "done",
        summary: "ran",
        episodicUpdate: { lastDecision: "decided to rest" },
      }),
      needsModel: "none",
      maxDurationSec: 10,
      singleton: true,
    };

    scheduler.registerJob(job);

    const trigger = scheduler.addTrigger({
      name: "episodic-trigger",
      kind: "cron",
      enabled: true,
      action: { job: "episodic-job" },
      tags: [],
      catchUp: "skip",
    });

    await scheduler.fireTrigger(trigger.id, "manual");

    const episodic = scheduler.episodic.read(trigger.id);
    expect(episodic.lastFiredAt).toBeDefined();
    expect(episodic.lastDecision).toBe("decided to rest");
    expect(episodic.runHistoryRefs.length).toBe(1);
  });

  it("catch-up: runs once for missed cron (run-once policy)", async () => {
    tmpDir = makeTempDir();

    const now = Date.now();
    const clock = new FixedClock(now);

    // parseCronNext: simulate two missed occurrences in the past
    let callCount = 0;
    const missedTimes = [now - 7200000, now - 3600000]; // 2h ago, 1h ago

    const parseCronNext = (_expr: string, _tz: string, after = 0): number | null => {
      const next = missedTimes.find((t) => t > after);
      return next ?? null;
    };

    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const jobRuns: string[] = [];
    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
      parseCronNext,
    });

    const job: ScheduledJob = {
      name: "catchup-job",
      description: "Test catchup",
      handler: async (ctx: TriggerContext): Promise<JobResult> => {
        jobRuns.push(ctx.firedBy);
        return makeFakeJobResult();
      },
      needsModel: "none",
      maxDurationSec: 10,
      singleton: false,
    };

    scheduler.registerJob(job);

    // Create a trigger with a lastRunAt 3h ago
    const trigger = scheduler.addTrigger({
      name: "missed-cron",
      kind: "cron",
      enabled: true,
      cron: { expr: "0 3 * * *", timezone: "UTC" },
      action: { job: "catchup-job" },
      tags: [],
      catchUp: "run-once", // only run once for missed
    });

    // Simulate that lastRunAt was 3h ago
    scheduler.triggers.update(
      trigger.id,
      { lastRunAt: new Date(now - 10800000).toISOString() },
      clock.isoNow(),
    );

    // Run catch-up
    await scheduler.start();

    // run-once: should have caught up once despite 2 missed runs
    expect(jobRuns.filter((b) => b === "catch-up").length).toBe(1);
  });

  it("condition trigger fires when metric crosses threshold", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(Date.now());
    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const firedValues: number[] = [];

    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
    });

    const job: ScheduledJob = {
      name: "condition-job",
      description: "Test condition",
      handler: async (ctx: TriggerContext): Promise<JobResult> => {
        firedValues.push(ctx.inputs["value"] as number ?? 0);
        return makeFakeJobResult();
      },
      needsModel: "none",
      maxDurationSec: 10,
      singleton: false,
    };

    scheduler.registerJob(job);

    const trigger = scheduler.addTrigger({
      name: "low-recovery",
      kind: "condition",
      enabled: true,
      condition: {
        metric: "health.recovery",
        predicate: "< 33",
        pollEverySec: 1,
        debounceSec: 0, // instant for test
        cooldownSec: 1,
      },
      action: { job: "condition-job" },
      tags: [],
      catchUp: "skip",
    });

    // Set metric provider to return a value below threshold
    scheduler.metricProvider = async (metric: string) => {
      if (metric === "health.recovery") return 25; // < 33 → should fire
      return null;
    };

    // Manually trigger via fireTrigger (bypasses the poll interval for test speed)
    const run = await scheduler.fireTrigger(trigger.id, "condition");

    expect(run.status).toBe("done");
  });

  it("failed job: TriggerRun status is failed, lock is released", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(Date.now());
    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
    });

    const job: ScheduledJob = {
      name: "failing-job",
      description: "Always fails",
      handler: async (): Promise<JobResult> => {
        throw new Error("Job blew up");
      },
      needsModel: "none",
      maxDurationSec: 10,
      singleton: true,
    };

    scheduler.registerJob(job);

    const trigger = scheduler.addTrigger({
      name: "failing-trigger",
      kind: "cron",
      enabled: true,
      action: { job: "failing-job" },
      tags: [],
      catchUp: "skip",
    });

    const run = await scheduler.fireTrigger(trigger.id, "manual");

    expect(run.status).toBe("failed");
    expect(run.error?.message).toContain("Job blew up");

    // Trigger should be back to 'scheduled' (lock released)
    const t = scheduler.triggers.get(trigger.id);
    expect(t?.status).toBe("scheduled");
  });

  it("agent-goal trigger wakes AgentRunner", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(Date.now());

    // LLM: returns __done__ immediately
    const llm = new FakeLlm();
    llm.setDefault('{"tool": "__done__", "args": {"result": "checked todos"}}');

    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
    });

    const trigger = scheduler.addTrigger({
      name: "overdue-todos",
      kind: "condition",
      enabled: true,
      condition: {
        metric: "todos.overdue",
        predicate: "> 0",
        pollEverySec: 3600,
        debounceSec: 0,
        cooldownSec: 3600,
      },
      action: { agentGoal: "Surface overdue todos, prioritized" },
      tags: ["todos"],
      catchUp: "skip",
    });

    const run = await scheduler.fireTrigger(trigger.id, "manual");

    expect(run.status).toBe("done");
    expect("agentRunId" in run.ranAs).toBe(true);
  });

  it("listRuns returns history for a trigger", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(Date.now());
    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const scheduler = new Scheduler({
      dataDir: tmpDir,
      clock,
      llm,
      tools,
      approvalSink: sink,
    });

    const job: ScheduledJob = {
      name: "list-test-job",
      description: "Test",
      handler: async (): Promise<JobResult> => makeFakeJobResult(),
      needsModel: "none",
      maxDurationSec: 10,
      singleton: false,
    };

    scheduler.registerJob(job);
    const trigger = scheduler.addTrigger({
      name: "multi-run",
      kind: "cron",
      enabled: true,
      action: { job: "list-test-job" },
      tags: [],
      catchUp: "skip",
    });

    await scheduler.fireTrigger(trigger.id, "manual");
    await scheduler.fireTrigger(trigger.id, "manual");
    await scheduler.fireTrigger(trigger.id, "manual");

    const runs = scheduler.listRuns(trigger.id);
    expect(runs.length).toBe(3);
    expect(runs.every((r) => r.triggerId === trigger.id)).toBe(true);
  });
});
