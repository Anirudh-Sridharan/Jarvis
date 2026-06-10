/**
 * consolidation-scheduler.test.ts
 *
 * The scheduler runs memory consolidation when capture activity goes quiet or a
 * burst accumulates — so captured turns become retrievable without a manual step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";
import { ConsolidationScheduler } from "../src/memory/consolidationScheduler.js";

function makeMemory() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sched-"));
  return createMemorySystem({
    embedder: new FakeEmbedder(),
    llm: new FakeLlm(),
    dataDir: dir,
  });
}

describe("ConsolidationScheduler", () => {
  let memory: ReturnType<typeof makeMemory>;
  let runSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    memory = makeMemory();
    runSpy = vi
      .spyOn(memory.consolidation, "run")
      .mockResolvedValue({ run: { counts: {} } } as never);
  });

  it("does not run when there are no pending records", async () => {
    const sched = new ConsolidationScheduler(memory, { log: () => {} });
    await sched.tick();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("waits while capture is active, then runs once it goes quiet", async () => {
    const sched = new ConsolidationScheduler(memory, {
      burstThreshold: 100,
      log: () => {},
    });

    // First, settle the empty baseline.
    await sched.tick();
    // A turn is captured → one pending record.
    await memory.capture.captureNote({ text: "buy milk", noteId: "n1" });

    // Tick 1 after capture: count changed (0→1) → still "active", no run.
    await sched.tick();
    expect(runSpy).not.toHaveBeenCalled();

    // Tick 2: count unchanged (quiet) → run.
    await sched.tick();
    expect(runSpy).toHaveBeenCalledWith("scheduler");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("runs immediately when a burst of records accumulates", async () => {
    await memory.capture.captureNote({ text: "note", noteId: "b1" });
    const sched = new ConsolidationScheduler(memory, {
      burstThreshold: 1,
      log: () => {},
    });
    await sched.tick(); // pending=1 >= threshold 1 → immediate
    expect(runSpy).toHaveBeenCalledWith("scheduler");
  });

  it("runNow is concurrency-guarded (no overlapping runs)", async () => {
    let resolveRun: () => void = () => {};
    runSpy.mockImplementation(
      () =>
        new Promise((r) => {
          resolveRun = () => r({ run: { counts: {} } } as never);
        }) as never,
    );
    const sched = new ConsolidationScheduler(memory, { log: () => {} });

    const p1 = sched.runNow("manual"); // starts, stays in-flight
    const second = await sched.runNow("manual"); // should be rejected as busy
    expect(second).toBeNull();

    resolveRun();
    await p1;
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
