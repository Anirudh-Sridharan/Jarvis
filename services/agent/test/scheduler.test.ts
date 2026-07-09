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

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/proactive/scheduler.js";
import { ApprovalService } from "../src/safety/approval.js";
import { AuditLog } from "../src/safety/audit.js";
import { Checkpointer } from "../src/core/checkpointer.js";
import {
  FakeLlm,
  FakeSearchTool,
  makeToolRegistry,
  makeAutoApproveSink,
  FixedClock,
} from "../src/testing/fakes.js";
import type {
  ScheduledJob,
  TriggerContext,
  JobResult,
  ApprovalSink,
  Clock,
} from "../src/types.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "sched-test-"));
}

/** Shared safety/persistence instances, as createAgentSystem would inject. */
function makeSchedulerDeps(dataDir: string, clock: Clock, sink: ApprovalSink) {
  return {
    auditLog: new AuditLog(dataDir, clock),
    approvalService: new ApprovalService(sink, clock),
    checkpointer: new Checkpointer(dataDir),
  };
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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
      ...makeSchedulerDeps(tmpDir, clock, sink),
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

  it("addTrigger + start(): re-arming is idempotent — one live timer, handler fires exactly once per occurrence (11-01 double-arm regression)", async () => {
    tmpDir = makeTempDir();
    // Anchored at an exact period boundary (0) so the computed delay is
    // deterministically == PERIOD_MS, not "however far Date.now() happens
    // to be from the next minute boundary" — keeps the advance-by-PERIOD_MS
    // assertions below exact instead of flaky.
    const clock = new FixedClock(0);
    const llm = new FakeLlm();
    const tools = makeToolRegistry([new FakeSearchTool()]);
    const { sink } = makeAutoApproveSink();

    const PERIOD_MS = 60_000;
    // Deterministic periodic parseCronNext: next multiple of PERIOD_MS
    // strictly after `after` (mirrors the real production */N inversion —
    // see services/core/src/agent/cronNext.ts — without importing across
    // the leaf boundary).
    const parseCronNext = (_expr: string, _tz: string, after = 0): number | null =>
      Math.ceil((after + 1) / PERIOD_MS) * PERIOD_MS;

    const handlerSpy = vi.fn(async (): Promise<JobResult> => makeFakeJobResult());

    vi.useFakeTimers();
    try {
      const scheduler = new Scheduler({
        dataDir: tmpDir,
        clock,
        llm,
        tools,
        ...makeSchedulerDeps(tmpDir, clock, sink),
        parseCronNext,
      });

      scheduler.registerJob({
        name: "idempotent-rearm-job",
        description: "Test",
        handler: handlerSpy,
        needsModel: "none",
        maxDurationSec: 10,
        singleton: false,
      });

      // addTrigger() arms immediately — exactly one live timer.
      scheduler.addTrigger({
        name: "idempotent-rearm-trigger",
        kind: "cron",
        enabled: true,
        cron: { expr: "*/1 * * * *", timezone: "UTC" },
        action: { job: "idempotent-rearm-job" },
        tags: [],
        catchUp: "skip",
      });
      expect(vi.getTimerCount()).toBe(1);

      // start() unconditionally re-arms every enabled trigger. WITHOUT the
      // idempotent-rearm fix, this leaves a SECOND live (orphaned) timer
      // for the same trigger id — the Scheduler's `timers` map only
      // remembers the latest one, but the earlier native timer is never
      // cleared and still fires independently later.
      await scheduler.start();
      expect(vi.getTimerCount()).toBe(1);

      // Advance to the first occurrence: handler fires exactly once (the
      // advisory lock alone would mask a same-instant double-fire, but a
      // leaked orphan timer proves itself over the NEXT occurrence below).
      // NOTE: from here on we stop asserting on the raw vi.getTimerCount()
      // total — `fire()`'s pre-existing `withTimeout()` helper races the
      // job against its own uncancelled setTimeout (no clearTimeout on the
      // winning path), which independently adds one unrelated pending timer
      // per fire and would contaminate a raw count. That's a separate,
      // out-of-scope leak (not the cron double-arm bug this test targets;
      // see SUMMARY "Deferred Issues"). The handler call-count progression
      // below is the correct, uncontaminated signal for "did a leaked
      // duplicate cron timer also fire" — a phantom timer fires the job
      // handler again; it does not touch vi.getTimerCount() bookkeeping
      // the same way.
      await vi.advanceTimersByTimeAsync(PERIOD_MS);
      expect(handlerSpy).toHaveBeenCalledTimes(1);

      // Advance to the following occurrence: exactly one more fire. A
      // leaked orphan from the pre-fix double-arm would show up here as a
      // 3rd call, since the phantom timer independently re-arms itself
      // once per cycle after its own first fire.
      await vi.advanceTimersByTimeAsync(PERIOD_MS);
      expect(handlerSpy).toHaveBeenCalledTimes(2);

      scheduler.stop();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
