/**
 * TelemetrySink tests — durable routing/turn records, recent() ring,
 * summary() aggregates, and logRouting/logTurn forwarding via setTelemetrySink.
 */

import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TelemetrySink } from "../src/inference/telemetrySink.js";
import { logRouting, logTurn, setTelemetrySink } from "../src/inference/telemetry.js";
import type { RoutingDecision } from "../src/inference/types.js";

function makeSink(): { sink: TelemetrySink; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return { sink: new TelemetrySink(db), db };
}

const routing: RoutingDecision = {
  target: "local",
  modelId: "qwen3-4b",
  reason: "taskHint:chat",
  estPromptTokens: 1200,
} as RoutingDecision;

afterEach(() => setTelemetrySink(null));

describe("TelemetrySink", () => {
  it("records routing + turns and returns them newest first", () => {
    const { sink } = makeSink();
    sink.recordRouting(routing);
    sink.recordTurn({
      modelId: "qwen3-4b",
      target: "local",
      ttftMs: 350,
      tokens: 120,
      durationMs: 4000,
      fallbackActive: false,
    });

    const recent = sink.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.kind).toBe("turn");
    expect(recent[0]!.ttftMs).toBe(350);
    expect(recent[1]!.kind).toBe("routing");
    expect(recent[1]!.estPromptTokens).toBe(1200);
  });

  it("survives a new sink over the same DB (durability)", () => {
    const db = new DatabaseSync(":memory:");
    const sink = new TelemetrySink(db);
    sink.recordTurn({
      modelId: "m",
      target: "hf",
      ttftMs: 900,
      tokens: 500,
      durationMs: 10_000,
      fallbackActive: true,
    });

    const sink2 = new TelemetrySink(db);
    const recent = sink2.recent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.target).toBe("hf");
    expect(recent[0]!.fallback).toBe(true);
  });

  it("summarizes turns: avg ttft, tps, target split, fallback count", () => {
    const { sink } = makeSink();
    sink.recordTurn({ modelId: "m", target: "local", ttftMs: 300, tokens: 100, durationMs: 2000, fallbackActive: false });
    sink.recordTurn({ modelId: "m", target: "local", ttftMs: 500, tokens: 200, durationMs: 4000, fallbackActive: false });
    sink.recordTurn({ modelId: "m", target: "hf", ttftMs: 1100, tokens: 600, durationMs: 6000, fallbackActive: true });
    sink.recordRouting(routing); // routing rows are excluded from turn aggregates

    const s = sink.summary(24);
    expect(s.turns).toBe(3);
    expect(s.avgTtftMs).toBe(Math.round((300 + 500 + 1100) / 3));
    expect(s.byTarget).toEqual({ local: 2, hf: 1 });
    expect(s.fallbackTurns).toBe(1);
    expect(s.avgTokensPerSec).toBeGreaterThan(0);
  });

  it("excludes ttft=-1 (no first token) from the ttft average", () => {
    const { sink } = makeSink();
    sink.recordTurn({ modelId: "m", target: "local", ttftMs: -1, tokens: 0, durationMs: 0, fallbackActive: false });
    sink.recordTurn({ modelId: "m", target: "local", ttftMs: 400, tokens: 10, durationMs: 1000, fallbackActive: false });

    expect(sink.summary(24).avgTtftMs).toBe(400);
  });
});

describe("telemetry forwarding", () => {
  it("logRouting/logTurn forward into the active sink", () => {
    const { sink } = makeSink();
    setTelemetrySink(sink);

    logRouting(routing);
    logTurn({ modelId: "m", target: "local", ttftMs: 250, tokens: 50, durationMs: 1000, fallbackActive: false });

    const recent = sink.recent(10);
    expect(recent.map((r) => r.kind)).toEqual(["turn", "routing"]);
  });

  it("a throwing sink never breaks logging", () => {
    setTelemetrySink({
      recordRouting() { throw new Error("boom"); },
      recordTurn() { throw new Error("boom"); },
    });
    expect(() => logRouting(routing)).not.toThrow();
    expect(() =>
      logTurn({ modelId: "m", target: "local", ttftMs: 1, tokens: 1, durationMs: 1, fallbackActive: false }),
    ).not.toThrow();
  });
});
