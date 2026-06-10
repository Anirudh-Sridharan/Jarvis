/**
 * model-manager-idle.test.ts
 *
 * Regression test: a load with NO request behind it (e.g. POST /warmup on
 * wake-word) must still arm the idle timer — otherwise the model stays
 * resident forever on a 16GB machine, violating the ~10-min idle-unload
 * invariant. endRequest() never runs in that flow.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ModelManager } from "../src/inference/modelManager.js";

function makeManager(idleMs = 1_000) {
  const mlx = {
    load: vi.fn(async () => {}),
    unload: vi.fn(async () => {}),
  };
  const events = { emit: vi.fn() };
  const ram = { headroomGB: () => 8 };
  const mm = new ModelManager(
    mlx as never,
    events as never,
    ram as never,
    { idleMs, killOnUnload: false },
  );
  return { mm, mlx };
}

describe("ModelManager — idle unload after a request-less load (warmup)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms the idle timer on load success with no active requests and unloads", async () => {
    vi.useFakeTimers();
    const { mm, mlx } = makeManager(1_000);

    await mm.ensureReady("qwen-local-chat", "some/ref"); // warmup: no request follows
    expect(mm.getState()).toBe("ready");

    await vi.advanceTimersByTimeAsync(1_001);

    expect(mlx.unload).toHaveBeenCalledOnce();
    expect(mm.getState()).toBe("unloaded");
  });

  it("does NOT unload while a request that followed the load is in flight", async () => {
    vi.useFakeTimers();
    const { mm, mlx } = makeManager(1_000);

    await mm.ensureReady("qwen-local-chat", "some/ref");
    mm.beginRequest(); // a real request arrives — clears the warmup idle timer

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mlx.unload).not.toHaveBeenCalled();
    expect(mm.getState()).toBe("generating");

    mm.endRequest(); // last request done — idle re-arms
    await vi.advanceTimersByTimeAsync(1_001);
    expect(mlx.unload).toHaveBeenCalledOnce();
    expect(mm.getState()).toBe("unloaded");
  });
});
