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
import { GatewayLlm } from "../src/memory/gatewayLlm.js";
import type { InferenceGateway } from "../src/inference/gateway.js";

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
    expect(second).toEqual({ status: "busy" });

    resolveRun();
    const first = await p1;
    expect(first.status).toBe("ok");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("runNow reports 'failed' (NOT 'busy') when the run throws, and resets the guard", async () => {
    runSpy.mockRejectedValueOnce(new Error("HF endpoint exploded"));
    const sched = new ConsolidationScheduler(memory, { log: () => {} });

    const r1 = await sched.runNow("manual");
    expect(r1).toEqual({ status: "failed", error: "HF endpoint exploded" });

    // The `running` flag must have been reset by the finally — a subsequent
    // run is NOT stuck on "busy".
    runSpy.mockResolvedValueOnce({ run: { counts: {} } } as never);
    const r2 = await sched.runNow("manual");
    expect(r2.status).toBe("ok");
    expect(runSpy).toHaveBeenCalledTimes(2);
  });
});

describe("GatewayLlm timeout → ConsolidationScheduler resilience", () => {
  it("a hung provider rejects via AbortSignal.timeout and the scheduler recovers", async () => {
    // Fake gateway whose chat() NEVER yields unless the threaded-through
    // AbortSignal fires — mirrors hfProvider/mlxProvider, which only time out
    // when given a signal.
    const fakeGateway = {
      chat: (_req: unknown, signal?: AbortSignal) =>
        (async function* () {
          await new Promise<never>((_resolve, reject) => {
            if (!signal) return; // hangs forever without a signal
            if (signal.aborted) {
              reject(signal.reason as Error);
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(signal.reason as Error),
              { once: true },
            );
          });
          yield { type: "token" as const, text: "unreachable" };
        })(),
    } as unknown as InferenceGateway;

    const llm = new GatewayLlm(fakeGateway, 25); // 25ms timeout for the test

    // complete() must reject (not hang) thanks to the timeout signal.
    await expect(llm.complete({ prompt: "consolidate this" })).rejects.toThrow();

    // Wire the hung LLM into a scheduler: runNow must settle as "failed" and
    // its finally must reset `running` so a later run is possible.
    const fakeMemory = {
      consolidation: { run: () => llm.complete({ prompt: "x" }) },
      store: { getPendingExperienceRecords: () => [] },
    } as never;
    const sched = new ConsolidationScheduler(fakeMemory, { log: () => {} });

    const r1 = await sched.runNow("manual");
    expect(r1.status).toBe("failed");

    // Not wedged: a second runNow is accepted (would be {status:"busy"} if
    // `running` never reset).
    const r2 = await sched.runNow("manual");
    expect(r2.status).toBe("failed"); // fails again, but it RAN — not busy
  });
});
