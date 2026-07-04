/**
 * Tests for the SQLite checkpointer (feature 16).
 *
 * Covers:
 *   - State persisted per step
 *   - Resume from checkpoint (load latest state)
 *   - Multiple steps accumulate checkpoints
 *   - Delete cleans up a run's checkpoints
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpointer } from "../src/core/checkpointer.js";
import { FixedClock } from "../src/testing/fakes.js";
import type { AgentState } from "../src/types.js";

function makeState(
  goal: string,
  step: number,
  status: AgentState["status"] = "running",
): AgentState {
  return {
    goal,
    plan: [goal],
    currentStep: step,
    scratchpad: [`step ${step} done`],
    observations: [],
    stepCount: step,
    validationRetries: 0,
    reflections: [],
    routeTier: "local",
    status,
  };
}

describe("Checkpointer", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a single checkpoint", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);

    const state = makeState("goal A", 0);
    cp.save("run-1", 0, state);

    const loaded = cp.load("run-1");
    expect(loaded).toBeDefined();
    expect(loaded?.seq).toBe(0);
    expect(loaded?.state.goal).toBe("goal A");
    expect(loaded?.state.currentStep).toBe(0);
  });

  it("load returns undefined for unknown runId", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);
    expect(cp.load("nonexistent")).toBeUndefined();
  });

  it("multiple saves: load returns the latest (highest seq)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);

    cp.save("run-2", 0, makeState("goal B", 0));
    cp.save("run-2", 1, makeState("goal B", 1));
    cp.save("run-2", 2, makeState("goal B", 2));

    const loaded = cp.load("run-2");
    expect(loaded?.seq).toBe(2);
    expect(loaded?.state.currentStep).toBe(2);
  });

  it("list returns all checkpoints in ascending order", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);

    for (let i = 0; i < 5; i++) {
      cp.save("run-3", i, makeState("goal C", i));
    }

    const list = cp.list("run-3");
    expect(list.length).toBe(5);
    expect(list.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("delete removes all checkpoints for a run", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);

    cp.save("run-4", 0, makeState("goal D", 0));
    cp.save("run-4", 1, makeState("goal D", 1));

    cp.delete("run-4");

    expect(cp.load("run-4")).toBeUndefined();
    expect(cp.list("run-4")).toHaveLength(0);
  });

  it("two runs are independent", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);

    cp.save("run-A", 0, makeState("goal A", 0));
    cp.save("run-B", 0, makeState("goal B", 0));

    const a = cp.load("run-A");
    const b = cp.load("run-B");

    expect(a?.state.goal).toBe("goal A");
    expect(b?.state.goal).toBe("goal B");
  });

  it("serializes and deserializes nested state correctly", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
    const cp = new Checkpointer(tmpDir);

    const state: AgentState = {
      goal: "complex goal",
      plan: ["step 1", "step 2"],
      currentStep: 1,
      scratchpad: ["[tool:search] → found results"],
      observations: [
        {
          id: "obs-1",
          toolCallId: "tc-1",
          ok: true,
          result: { data: [1, 2, 3] },
          latencyMs: 150,
          truncated: false,
        },
      ],
      stepCount: 3,
      validationRetries: 1,
      reflections: ["tried again"],
      routeTier: "hf",
      status: "running",
    };

    cp.save("run-complex", 1, state);
    const loaded = cp.load("run-complex");

    expect(loaded?.state.observations[0]?.result).toEqual({ data: [1, 2, 3] });
    expect(loaded?.state.reflections).toContain("tried again");
    expect(loaded?.state.routeTier).toBe("hf");
  });

  describe("sweepOrphaned", () => {
    const STALE_AFTER_MS = 1000;

    it("sweeps a stale 'running' run not in activeRunIds", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      cp.save("run-stale", 0, makeState("goal", 0, "running"));
      clock.advance(STALE_AFTER_MS + 1);

      const swept = cp.sweepOrphaned({ staleAfterMs: STALE_AFTER_MS });

      expect(swept).toBe(1);
      expect(cp.load("run-stale")).toBeUndefined();
    });

    it("preserves an 'awaiting-approval' run even when stale", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      cp.save("run-approval", 0, makeState("goal", 0, "awaiting-approval"));
      clock.advance(STALE_AFTER_MS * 100);

      const swept = cp.sweepOrphaned({ staleAfterMs: STALE_AFTER_MS });

      expect(swept).toBe(0);
      expect(cp.load("run-approval")).toBeDefined();
    });

    it("preserves a run listed in activeRunIds even when stale", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      cp.save("run-active", 0, makeState("goal", 0, "running"));
      clock.advance(STALE_AFTER_MS + 1);

      const swept = cp.sweepOrphaned({
        staleAfterMs: STALE_AFTER_MS,
        activeRunIds: ["run-active"],
      });

      expect(swept).toBe(0);
      expect(cp.load("run-active")).toBeDefined();
    });

    it("preserves a recent 'running' run (within staleAfterMs)", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      cp.save("run-recent", 0, makeState("goal", 0, "running"));
      clock.advance(STALE_AFTER_MS - 1);

      const swept = cp.sweepOrphaned({ staleAfterMs: STALE_AFTER_MS });

      expect(swept).toBe(0);
      expect(cp.load("run-recent")).toBeDefined();
    });

    it("sweeps a stale terminal ('done') run whose rows were orphaned", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      cp.save("run-done", 0, makeState("goal", 0, "done"));
      clock.advance(STALE_AFTER_MS + 1);

      const swept = cp.sweepOrphaned({ staleAfterMs: STALE_AFTER_MS });

      expect(swept).toBe(1);
      expect(cp.load("run-done")).toBeUndefined();
    });

    it("returns 0 and deletes nothing on an empty DB", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      const swept = cp.sweepOrphaned({ staleAfterMs: STALE_AFTER_MS });

      expect(swept).toBe(0);
    });

    it("returns a count matching deletions when runs mix swept/preserved", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "cp-test-"));
      const clock = new FixedClock(0);
      const cp = new Checkpointer(tmpDir, clock);

      cp.save("run-mix-stale-1", 0, makeState("goal", 0, "running"));
      cp.save("run-mix-stale-2", 0, makeState("goal", 0, "done"));
      cp.save("run-mix-approval", 0, makeState("goal", 0, "awaiting-approval"));
      cp.save("run-mix-active", 0, makeState("goal", 0, "running"));

      clock.advance(STALE_AFTER_MS + 1);
      cp.save("run-mix-recent", 0, makeState("goal", 0, "running"));

      const swept = cp.sweepOrphaned({
        staleAfterMs: STALE_AFTER_MS,
        activeRunIds: ["run-mix-active"],
      });

      expect(swept).toBe(2);
      expect(cp.load("run-mix-stale-1")).toBeUndefined();
      expect(cp.load("run-mix-stale-2")).toBeUndefined();
      expect(cp.load("run-mix-approval")).toBeDefined();
      expect(cp.load("run-mix-active")).toBeDefined();
      expect(cp.load("run-mix-recent")).toBeDefined();
    });
  });
});
