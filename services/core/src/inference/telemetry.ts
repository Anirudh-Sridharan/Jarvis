/**
 * Telemetry (feature 1): TTFT / tokens-per-second / routing + fallback logging.
 *
 * Phase 1 logs to stderr in a structured, greppable form. Later this feeds the
 * life-metrics dashboard.
 *
 * TODO(phase3: feature dashboard) emit these as structured events to a metrics sink.
 */
import type { RoutingDecision } from "./types.js";

function ts(): string {
  return new Date().toISOString();
}

export function logRouting(d: RoutingDecision): void {
  console.error(
    `[telemetry ${ts()}] routing target=${d.target} model=${d.modelId} reason=${d.reason} estTokens=${d.estPromptTokens}`,
  );
}

export interface TurnMetrics {
  modelId: string;
  target: string;
  ttftMs: number;
  tokens: number;
  durationMs: number;
  fallbackActive: boolean;
}

export function logTurn(m: TurnMetrics): void {
  const tps = m.durationMs > 0 ? (m.tokens / (m.durationMs / 1000)).toFixed(1) : "0";
  console.error(
    `[telemetry ${ts()}] turn target=${m.target} model=${m.modelId} ttft=${m.ttftMs}ms tokens=${m.tokens} tps=${tps} fallback=${m.fallbackActive}`,
  );
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

  finish(meta: { modelId: string; target: string; fallbackActive: boolean }): void {
    const now = Date.now();
    logTurn({
      modelId: meta.modelId,
      target: meta.target,
      ttftMs: this.firstTokenAt ? this.firstTokenAt - this.start : -1,
      tokens: this.tokens,
      durationMs: now - this.start,
      fallbackActive: meta.fallbackActive,
    });
  }
}
