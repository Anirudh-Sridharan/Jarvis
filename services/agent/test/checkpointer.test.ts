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
import type { AgentState } from "../src/types.js";

function makeState(goal: string, step: number): AgentState {
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
    status: "running",
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
});
