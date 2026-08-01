/**
 * Telemetry (feature 1): TTFT / tokens-per-second / routing + fallback logging.
 *
 * Logs to stderr in a structured, greppable form AND forwards to the
 * TelemetrySink when one is wired (server startup) — the sink persists to
 * SQLite and feeds GET /telemetry for the dashboard.
 */
import type { RoutingDecision } from "./types.js";

/** Sink forwarding — avoids threading the sink through router/gateway ctors. */
interface ForwardSink {
  recordRouting(d: RoutingDecision): void;
  recordTurn(m: TurnMetrics): void;
}
let activeSink: ForwardSink | null = null;
export function setTelemetrySink(sink: ForwardSink | null): void {
  activeSink = sink;
}

function ts(): string {
  return new Date().toISOString();
}

export function logRouting(d: RoutingDecision): void {
  console.error(
    `[telemetry ${ts()}] routing target=${d.target} model=${d.modelId} reason=${d.reason} estTokens=${d.estPromptTokens}`,
  );
  try {
    activeSink?.recordRouting(d);
  } catch {
    /* telemetry must never break inference */
  }
}

export interface TurnMetrics {
  modelId: string;
  target: string;
  ttftMs: number;
  tokens: number;
  durationMs: number;
  fallbackActive: boolean;
  /**
   * false = the turn ended on an ERROR exit (dead provider, failed fallback).
   * Absent/true = completed normally. Recorded so a dead provider produces a
   * queryable failure rate instead of being indistinguishable from no
   * traffic (WR-04).
   */
  ok?: boolean;
}

export function logTurn(m: TurnMetrics): void {
  const tps = m.durationMs > 0 ? (m.tokens / (m.durationMs / 1000)).toFixed(1) : "0";
  console.error(
    `[telemetry ${ts()}] turn target=${m.target} model=${m.modelId} ttft=${m.ttftMs}ms tokens=${m.tokens} tps=${tps} fallback=${m.fallbackActive} ok=${m.ok !== false}`,
  );
  try {
    activeSink?.recordTurn(m);
  } catch {
    /* telemetry must never break inference */
  }
}

/** Tracks time-to-first-token + token count across a single stream. */
export class TurnTimer {
  private readonly start = Date.now();
  private firstTokenAt: number | undefined;
  private tokens = 0;

  recordToken(): void {
    if (this.firstTokenAt === undefined) this.firstTokenAt = Date.now();
    this.tokens++;
  }

  finish(meta: {
    modelId: string;
    target: string;
    fallbackActive: boolean;
    /** Pass false on error exits so failed turns are recorded (WR-04). */
    ok?: boolean;
  }): void {
    const now = Date.now();
    logTurn({
      modelId: meta.modelId,
      target: meta.target,
      ttftMs: this.firstTokenAt ? this.firstTokenAt - this.start : -1,
      tokens: this.tokens,
      durationMs: now - this.start,
      fallbackActive: meta.fallbackActive,
      ok: meta.ok ?? true,
    });
  }
}
