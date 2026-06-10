/**
 * sessionMachine.test.ts
 *
 * Tests for the VoiceSessionState machine: valid/invalid transitions,
 * wake→waking→listening flow, barge-in edge, observer notifications.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionMachine } from "../src/sessionMachine.js";
import type { StateTransition, TransitionEvent } from "../src/sessionMachine.js";

describe("SessionMachine — initial state", () => {
  it("starts in idle", () => {
    const m = new SessionMachine();
    expect(m.state).toBe("idle");
  });

  it("has empty history initially", () => {
    const m = new SessionMachine();
    expect(m.history).toHaveLength(0);
  });
});

describe("SessionMachine — valid transitions", () => {
  it("idle → WAKE → waking", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    expect(m.state).toBe("waking");
  });

  it("waking → MODELS_READY → listening", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    expect(m.state).toBe("listening");
  });

  it("listening → TURN_COMPLETE → thinking", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");
    expect(m.state).toBe("thinking");
  });

  it("thinking → FIRST_TOKEN → speaking", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");
    m.send("FIRST_TOKEN");
    expect(m.state).toBe("speaking");
  });

  it("speaking → REPLY_DONE → idle", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");
    m.send("FIRST_TOKEN");
    m.send("REPLY_DONE");
    expect(m.state).toBe("idle");
  });

  it("full happy-path wake → idle cycle", () => {
    const m = new SessionMachine();
    const states: string[] = [m.state];
    const unsub = m.onTransition((t) => states.push(t.to));

    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");
    m.send("FIRST_TOKEN");
    m.send("REPLY_DONE");

    expect(states).toEqual(["idle", "waking", "listening", "thinking", "speaking", "idle"]);
    unsub();
  });

  it("any state → ERROR → error", () => {
    for (const setupEvent of [
      [] as TransitionEvent[],
      ["WAKE"] as TransitionEvent[],
      ["WAKE", "MODELS_READY"] as TransitionEvent[],
      ["WAKE", "MODELS_READY", "TURN_COMPLETE"] as TransitionEvent[],
      ["WAKE", "MODELS_READY", "TURN_COMPLETE", "FIRST_TOKEN"] as TransitionEvent[],
    ]) {
      const m = new SessionMachine();
      for (const e of setupEvent) m.send(e);
      m.send("ERROR");
      expect(m.state).toBe("error");
    }
  });

  it("error → RECOVER → idle", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("ERROR");
    expect(m.state).toBe("error");
    m.send("RECOVER");
    expect(m.state).toBe("idle");
  });

  it("FORCE_IDLE works from multiple states", () => {
    for (const setup of [
      [] as TransitionEvent[],
      ["WAKE"] as TransitionEvent[],
      ["WAKE", "MODELS_READY"] as TransitionEvent[],
    ]) {
      const m = new SessionMachine();
      for (const e of setup) m.send(e);
      m.send("FORCE_IDLE");
      expect(m.state).toBe("idle");
    }
  });
});

describe("SessionMachine — barge-in (speaking → listening)", () => {
  it("speaking → BARGE_IN → listening", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");
    m.send("FIRST_TOKEN");
    expect(m.state).toBe("speaking");

    m.send("BARGE_IN");
    expect(m.state).toBe("listening");
  });

  it("thinking → BARGE_IN → listening (early barge-in)", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");
    expect(m.state).toBe("thinking");

    m.send("BARGE_IN");
    expect(m.state).toBe("listening");
  });

  it("idle → BARGE_IN is not a legal transition (trySend returns null)", () => {
    const m = new SessionMachine();
    const result = m.trySend("BARGE_IN");
    expect(result).toBeNull();
    expect(m.state).toBe("idle"); // unchanged
  });

  it("listening → BARGE_IN is not a legal transition", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    const result = m.trySend("BARGE_IN");
    expect(result).toBeNull();
    expect(m.state).toBe("listening");
  });
});

describe("SessionMachine — invalid transitions", () => {
  it("throws on illegal transition via send()", () => {
    const m = new SessionMachine();
    expect(() => m.send("TURN_COMPLETE")).toThrow("Illegal transition");
  });

  it("returns null on illegal transition via trySend()", () => {
    const m = new SessionMachine();
    const result = m.trySend("REPLY_DONE");
    expect(result).toBeNull();
    expect(m.state).toBe("idle"); // unchanged
  });

  it("idle → MODELS_READY is illegal", () => {
    const m = new SessionMachine();
    expect(() => m.send("MODELS_READY")).toThrow();
  });

  it("waking → TURN_COMPLETE is illegal", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    expect(() => m.send("TURN_COMPLETE")).toThrow();
  });
});

describe("SessionMachine — observer notifications", () => {
  it("notifies listeners on every transition", () => {
    const m = new SessionMachine();
    const transitions: StateTransition[] = [];
    m.onTransition((t) => transitions.push(t));

    m.send("WAKE");
    m.send("MODELS_READY");

    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.from).toBe("idle");
    expect(transitions[0]?.to).toBe("waking");
    expect(transitions[0]?.event).toBe("WAKE");
    expect(transitions[1]?.from).toBe("waking");
    expect(transitions[1]?.to).toBe("listening");
  });

  it("unsubscribe stops notifications", () => {
    const m = new SessionMachine();
    const calls: string[] = [];
    const unsub = m.onTransition((t) => calls.push(t.to));

    m.send("WAKE");
    unsub();
    m.send("MODELS_READY");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("waking");
  });

  it("listener errors do not crash the machine", () => {
    const m = new SessionMachine();
    m.onTransition(() => { throw new Error("listener bug"); });
    expect(() => m.send("WAKE")).not.toThrow();
    expect(m.state).toBe("waking");
  });

  it("transition has a numeric ts field", () => {
    const m = new SessionMachine();
    const before = Date.now();
    m.onTransition((t) => {
      expect(t.ts).toBeGreaterThanOrEqual(before);
      expect(t.ts).toBeLessThanOrEqual(Date.now() + 10);
    });
    m.send("WAKE");
  });
});

describe("SessionMachine — canSend()", () => {
  it("returns true for valid events", () => {
    const m = new SessionMachine();
    expect(m.canSend("WAKE")).toBe(true);
    expect(m.canSend("FORCE_IDLE")).toBe(true);
  });

  it("returns false for invalid events", () => {
    const m = new SessionMachine();
    expect(m.canSend("BARGE_IN")).toBe(false);
    expect(m.canSend("TURN_COMPLETE")).toBe(false);
  });
});

describe("SessionMachine — history", () => {
  it("records all transitions in order", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.send("TURN_COMPLETE");

    expect(m.history).toHaveLength(3);
    expect(m.history[0]?.event).toBe("WAKE");
    expect(m.history[1]?.event).toBe("MODELS_READY");
    expect(m.history[2]?.event).toBe("TURN_COMPLETE");
  });

  it("reset() clears history and returns to idle", () => {
    const m = new SessionMachine();
    m.send("WAKE");
    m.send("MODELS_READY");
    m.reset();
    expect(m.state).toBe("idle");
    expect(m.history).toHaveLength(0);
  });
});

describe("SessionMachine — PTT flow", () => {
  it("idle → PTT_PRESS → waking", () => {
    const m = new SessionMachine();
    m.send("PTT_PRESS");
    expect(m.state).toBe("waking");
  });

  it("PTT then models ready → listening", () => {
    const m = new SessionMachine();
    m.send("PTT_PRESS");
    m.send("MODELS_READY");
    expect(m.state).toBe("listening");
  });
});
