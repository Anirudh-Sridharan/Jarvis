/**
 * cron-arming.test.ts
 *
 * Integration proof for the 11-01 cron-arming fix: this is the FIX FIRST,
 * blocking prerequisite for MEM-04 (11-02) — the proactive Scheduler's
 * armCron()/catchUp() silently no-op without a real parseCronNext
 * (`if (!t.cron || !this.opts.parseCronNext) return;`), so before this fix
 * NO cron trigger ever fired live in production (createAgentSystem() never
 * supplied one).
 *
 * POSITIVE CASE: a REAL (non-fake) parseCronNext (imported from
 * ../src/agent/cronNext.js — the same one 11-01 injects into
 * createAgentSystem() in agentSystem.ts) causes an enabled cron trigger to
 * fire via its ARMED TIMER (fired_by="cron") with NO manual fireTrigger
 * call. It also pins exactly-once firing under the addTrigger()+start()
 * double-arm sequence (the idempotent re-arm guard added to
 * services/agent/src/proactive/scheduler.ts).
 *
 * NEGATIVE CONTROL: an identical setup built WITHOUT parseCronNext never
 * fires — proving the positive result is caused by the real parser, not a
 * fake-parser or test-harness artifact.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSystem } from "@jarvis/agent";
import type { JobResult } from "@jarvis/agent";
import { FakeLlm, FixedClock, makeAutoApproveSink, makeToolRegistry } from "@jarvis/agent/testing";

import { parseCronNext } from "../src/agent/cronNext.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "jarvis-cron-arming-test-"));
}

const CRON_EXPR = "*/5 * * * *";

describe("cron-arming: real parseCronNext arms + fires a cron trigger unattended", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("POSITIVE: fires an enabled cron trigger via its armed timer (fired_by=cron), no manual fireTrigger call, exactly once", async () => {
    tmpDir = makeTempDir();
    // Anchored at an exact 5-minute-period boundary (0) so the computed
    // delay below is deterministic, not "however far Date.now() happens to
    // be from the next 5-minute boundary".
    const clock = new FixedClock(0);
    const { sink } = makeAutoApproveSink();

    const handlerSpy = vi.fn(async (): Promise<JobResult> => ({ status: "done", summary: "ran" }));

    vi.useFakeTimers();

    // REAL parseCronNext — the same function 11-01 injects into
    // createAgentSystem in services/core/src/agent/agentSystem.ts. NOT a
    // locally-defined fake.
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools: makeToolRegistry([]),
      clock,
      dataDir: tmpDir,
      approvalSink: sink,
      parseCronNext,
    });

    agentSystem.triggers.registerJob({
      name: "cron-arming-test-job",
      description: "Test job for cron-arming proof",
      handler: handlerSpy,
      needsModel: "none",
      maxDurationSec: 10,
      singleton: false,
    });

    // addTrigger() arms immediately; start() re-arms every enabled trigger
    // (the double-arm sequence the idempotent-rearm guard in
    // services/agent/src/proactive/scheduler.ts protects against).
    const trigger = agentSystem.triggers.addTrigger({
      name: "cron-arming-test-trigger",
      kind: "cron",
      enabled: true,
      cron: { expr: CRON_EXPR, timezone: "UTC" },
      action: { job: "cron-arming-test-job" },
      tags: [],
      catchUp: "skip",
    });

    await agentSystem.triggers.start();

    const nextMs = parseCronNext(CRON_EXPR, "UTC", clock.now());
    expect(nextMs).not.toBeNull();
    const delay = nextMs! - clock.now();

    // Advance the armed timer to its computed next-occurrence — NO
    // fireTrigger call anywhere in this test body.
    await vi.advanceTimersByTimeAsync(delay);

    // (a) the handler fired via the armed timer, exactly once (pins
    // exactly-once firing under the addTrigger+start double-arm sequence).
    expect(handlerSpy).toHaveBeenCalledTimes(1);

    // (b) a persisted TriggerRun with firedBy === "cron" exists.
    const runs = agentSystem.triggers.listRuns(trigger.id);
    expect(runs.some((r) => r.firedBy === "cron")).toBe(true);

    agentSystem.triggers.stop();
  });

  it("NEGATIVE CONTROL: without parseCronNext, the same cron trigger never fires (armCron early-returns, no timer armed)", async () => {
    tmpDir = makeTempDir();
    const clock = new FixedClock(0);
    const { sink } = makeAutoApproveSink();

    const handlerSpy = vi.fn(async (): Promise<JobResult> => ({ status: "done", summary: "ran" }));

    vi.useFakeTimers();

    // Identical setup to the positive case, EXCEPT parseCronNext is
    // intentionally omitted — this is the exact production gap 11-01 fixes.
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools: makeToolRegistry([]),
      clock,
      dataDir: tmpDir,
      approvalSink: sink,
      // parseCronNext: OMITTED on purpose.
    });

    agentSystem.triggers.registerJob({
      name: "cron-arming-negative-job",
      description: "Negative-control job",
      handler: handlerSpy,
      needsModel: "none",
      maxDurationSec: 10,
      singleton: false,
    });

    agentSystem.triggers.addTrigger({
      name: "cron-arming-negative-trigger",
      kind: "cron",
      enabled: true,
      cron: { expr: CRON_EXPR, timezone: "UTC" },
      action: { job: "cron-arming-negative-job" },
      tags: [],
      catchUp: "skip",
    });

    await agentSystem.triggers.start();

    // Advance well past where a real cron trigger on this schedule would
    // have fired (a full simulated day, 288x the 5-minute period).
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(handlerSpy).not.toHaveBeenCalled();

    agentSystem.triggers.stop();
  });
});
