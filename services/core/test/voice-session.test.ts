/**
 * Tests for the dashboard voice session: HttpWakeSource (HTTP-fed wake events)
 * and VoiceSessionManager (lifecycle, event relay, ring buffer). All deps are
 * fakes — no network, no audio processes, no models.
 */
import { describe, it, expect } from "vitest";
import type { WakeEvent } from "@jarvis/voice";
import { HttpWakeSource } from "../src/voice/httpWakeSource.js";

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
});
