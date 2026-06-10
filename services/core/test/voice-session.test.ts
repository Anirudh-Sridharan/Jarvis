/**
 * Tests for the dashboard voice session: HttpWakeSource (HTTP-fed wake events)
 * and VoiceSessionManager (lifecycle, event relay, ring buffer). All deps are
 * fakes — no network, no audio processes, no models.
 */
import { describe, it, expect, vi } from "vitest";
import type { WakeEvent } from "@jarvis/voice";
import { createVoiceOrchestrator } from "@jarvis/voice";
import { FakeSttEngine, FakeTtsEngine, FakeCoreClient } from "@jarvis/voice/testing";
import { HttpWakeSource } from "../src/voice/httpWakeSource.js";
import {
  VoiceSessionManager,
  type VoiceEventFrame,
} from "../src/voice/voiceSessionManager.js";

function wakeEvent(partial?: Partial<WakeEvent>): WakeEvent {
  return {
    id: partial?.id ?? "wake-1",
    source: "wakeword",
    phrase: "Hey Jarvis",
    confidence: partial?.confidence ?? 0.9,
    timestamp: partial?.timestamp ?? 1718000000000,
    deviceId: partial?.deviceId ?? "test-mic",
    warmTriggered: false,
  };
}

describe("HttpWakeSource", () => {
  it("forwards dispatched events to listeners while started", () => {
    const source = new HttpWakeSource();
    const received: WakeEvent[] = [];
    source.onWake((e) => received.push(e));
    source.start();
    source.dispatch(wakeEvent());
    expect(received).toHaveLength(1);
    expect(received[0]?.deviceId).toBe("test-mic");
  });

  it("drops events before start() and after stop()", () => {
    const source = new HttpWakeSource();
    const received: WakeEvent[] = [];
    source.onWake((e) => received.push(e));
    source.dispatch(wakeEvent()); // not started yet
    source.start();
    source.stop();
    source.dispatch(wakeEvent()); // stopped
    expect(received).toHaveLength(0);
  });

  it("unsubscribe stops delivery", () => {
    const source = new HttpWakeSource();
    const received: WakeEvent[] = [];
    const unsub = source.onWake((e) => received.push(e));
    source.start();
    unsub();
    source.dispatch(wakeEvent());
    expect(received).toHaveLength(0);
  });

  it("delivers to listeners subscribed after start() — the orchestrator's call order", () => {
    const source = new HttpWakeSource();
    const received: WakeEvent[] = [];
    source.start();
    source.onWake((e) => received.push(e));
    expect(source.dispatch(wakeEvent())).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("delivers again after a stop/start cycle (re-arm)", () => {
    const source = new HttpWakeSource();
    const received: WakeEvent[] = [];
    source.onWake((e) => received.push(e));
    source.start();
    source.stop();
    expect(source.dispatch(wakeEvent())).toBe(false);
    source.start();
    expect(source.dispatch(wakeEvent())).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("fans out to multiple listeners", () => {
    const source = new HttpWakeSource();
    const a: WakeEvent[] = [];
    const b: WakeEvent[] = [];
    source.onWake((e) => a.push(e));
    source.onWake((e) => b.push(e));
    source.start();
    source.dispatch(wakeEvent());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

// ── VoiceSessionManager ──────────────────────────────────────────────────────

/** Fake sidecar fetch: records calls; /health and /wake/* succeed unless told otherwise. */
function fakeSidecarFetch(calls: string[], opts?: { healthDown?: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/health")) {
      return opts?.healthDown
        ? new Response("down", { status: 503 })
        : Response.json({ state: "ready" });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
}

/** Manager wired to a real orchestrator over @jarvis/voice fakes. */
function makeManager(opts?: { healthDown?: boolean; bufferSize?: number }) {
  const calls: string[] = [];
  const stt = new FakeSttEngine();
  const tts = new FakeTtsEngine();
  const core = new FakeCoreClient();
  const manager = new VoiceSessionManager({
    sidecarUrl: "http://sidecar.test",
    fetchImpl: fakeSidecarFetch(calls, opts),
    bufferSize: opts?.bufferSize,
    orchestratorFactory: (wakeSource) =>
      createVoiceOrchestrator({ wakeWord: wakeSource, stt, tts, core }),
  });
  return { manager, calls, stt, tts, core };
}

describe("VoiceSessionManager", () => {
  it("start() enables the sidecar wake listener and reports active", async () => {
    const { manager, calls } = makeManager();
    const result = await manager.start();
    expect(result.ok).toBe(true);
    expect(calls).toContain("http://sidecar.test/health");
    expect(calls).toContain("http://sidecar.test/wake/enable");
    expect(manager.status().active).toBe(true);
    expect(manager.status().state).toBe("idle");
    await manager.stop();
  });

  it("start() is idempotent — second call succeeds without re-enabling wake", async () => {
    const { manager, calls } = makeManager();
    await manager.start();
    const enables = calls.filter((u) => u.endsWith("/wake/enable")).length;
    const again = await manager.start();
    expect(again.ok).toBe(true);
    expect(calls.filter((u) => u.endsWith("/wake/enable")).length).toBe(enables);
    await manager.stop();
  });

  it("start() fails with a helpful error when the sidecar is down", async () => {
    const { manager } = makeManager({ healthDown: true });
    const result = await manager.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sidecar/i);
    expect(manager.status().active).toBe(false);
  });

  it("dispatchWake() triggers a turn: warmup called, events relayed to subscribers", async () => {
    const { manager, core } = makeManager();
    await manager.start();
    const frames: VoiceEventFrame[] = [];
    manager.subscribe((f) => frames.push(f));

    const accepted = manager.dispatchWake(wakeEvent());
    expect(accepted).toBe(true);
    expect(manager.status().lastWakeAt).not.toBeNull();

    await vi.waitFor(() => {
      expect(core.warmupCalls).toBeGreaterThan(0);
      expect(frames.some((f) => f.event.type === "wake")).toBe(true);
      expect(frames.some((f) => f.event.type === "state_change")).toBe(true);
    });
    await manager.stop();
  });

  it("dispatchWake() is rejected when the session is not active", () => {
    const { manager } = makeManager();
    expect(manager.dispatchWake(wakeEvent())).toBe(false);
  });

  it("stop() disables the sidecar wake listener and drops late wakes", async () => {
    const { manager, calls, core } = makeManager();
    await manager.start();
    await manager.stop();
    expect(calls).toContain("http://sidecar.test/wake/disable");
    expect(manager.status().active).toBe(false);
    expect(manager.dispatchWake(wakeEvent())).toBe(false);
    expect(core.warmupCalls).toBe(0);
  });

  it("keeps a bounded ring buffer with monotonic seq for replay", async () => {
    const { manager } = makeManager({ bufferSize: 2 });
    await manager.start();
    manager.dispatchWake(wakeEvent({ id: "w1" }));
    await vi.waitFor(() => {
      expect(manager.recentEvents().length).toBeGreaterThanOrEqual(2);
    });
    const recent = manager.recentEvents();
    expect(recent.length).toBe(2); // trimmed to bufferSize
    const seqs = recent.map((f) => f.seq);
    expect(seqs[1]).toBe((seqs[0] ?? 0) + 1); // monotonic
    await manager.stop();
  });

  it("concurrent start() calls produce one session and one wake/enable", async () => {
    const { manager, calls } = makeManager();
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls.filter((u) => u.endsWith("/wake/enable")).length).toBe(1);
    await manager.stop();
  });

  it("fast stop()/start() overlap leaves the new session armed", async () => {
    const { manager } = makeManager();
    await manager.start();
    const stopping = manager.stop();
    const restarting = manager.start();
    await Promise.all([stopping, restarting]);
    expect(manager.status().active).toBe(true);
    expect(manager.dispatchWake(wakeEvent())).toBe(true);
    await manager.stop();
  });

  it("a throwing subscriber does not starve other subscribers", async () => {
    const { manager } = makeManager();
    await manager.start();
    const frames: VoiceEventFrame[] = [];
    manager.subscribe(() => {
      throw new Error("closed SSE stream");
    });
    manager.subscribe((f) => frames.push(f));
    manager.dispatchWake(wakeEvent());
    await vi.waitFor(() => {
      expect(frames.some((f) => f.event.type === "wake")).toBe(true);
    });
    await manager.stop();
  });
});
