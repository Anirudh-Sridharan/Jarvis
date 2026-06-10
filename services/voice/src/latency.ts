/**
 * Latency accounting for the voice loop (feature 7).
 *
 * Records per-stage timestamps for a single voice turn and computes the
 * headline "eos → first audio" budget along with all sub-stage durations.
 *
 * Budget targets (from spec, post-warm-up M3 Air):
 *   EOS detection:         0–10ms
 *   STT finalize:         50–120ms
 *   LLM TTFT:           300–700ms  ← bottleneck
 *   First sentence ready: 10–40ms
 *   TTS first audio:    150–300ms
 *   Total EOS→audio:    700–1500ms
 */

export interface TurnLatency {
  turnId: string;
  /** Timestamp at end-of-speech (VAD speech_end event). */
  eosAt: number;
  /** Timestamp when STT produced the final transcript. */
  sttFinalAt: number | null;
  /** Timestamp when the first LLM token arrived. */
  llmFirstTokenAt: number | null;
  /** Timestamp when the first sentence chunk was emitted by the chunker. */
  firstChunkAt: number | null;
  /** Timestamp when TTS began playing the first audio frame. */
  firstAudioAt: number | null;
  /** Timestamp when TTS finished playing the reply. */
  replyDoneAt: number | null;

  // Computed deltas (null if the required timestamps are missing)
  eosToSttFinalMs: number | null;
  sttFinalToTtftMs: number | null;
  ttftToFirstAudioMs: number | null;
  eosToFirstAudioMs: number | null;
  totalTurnMs: number | null;
}

export interface BudgetThresholds {
  eosToSttFinalWarnMs: number;
  sttFinalToTtftWarnMs: number;
  ttftToFirstAudioWarnMs: number;
  eosToFirstAudioWarnMs: number;
}

const DEFAULT_BUDGET: BudgetThresholds = {
  eosToSttFinalWarnMs: 150,
  sttFinalToTtftWarnMs: 750,
  ttftToFirstAudioWarnMs: 350,
  eosToFirstAudioWarnMs: 1500,
};

export class TurnLatencyTracker {
  private eosAt: number | null = null;
  private sttFinalAt: number | null = null;
  private llmFirstTokenAt: number | null = null;
  private firstChunkAt: number | null = null;
  private firstAudioAt: number | null = null;
  private replyDoneAt: number | null = null;

  constructor(
    private readonly turnId: string,
    private readonly thresholds: BudgetThresholds = DEFAULT_BUDGET,
  ) {}

  markEos(ts: number = Date.now()): void {
    this.eosAt = ts;
  }

  markSttFinal(ts: number = Date.now()): void {
    this.sttFinalAt = ts;
  }

  markLlmFirstToken(ts: number = Date.now()): void {
    this.llmFirstTokenAt = ts;
  }

  markFirstChunk(ts: number = Date.now()): void {
    this.firstChunkAt = ts;
  }

  markFirstAudio(ts: number = Date.now()): void {
    this.firstAudioAt = ts;
  }

  markReplyDone(ts: number = Date.now()): void {
    this.replyDoneAt = ts;
  }

  /** Compute and return the final TurnLatency record. */
  finish(): TurnLatency {
    const eos = this.eosAt;
    if (eos === null) {
      throw new Error("[TurnLatencyTracker] markEos() was never called");
    }

    const delta = (a: number | null, b: number | null): number | null =>
      a !== null && b !== null ? b - a : null;

    const result: TurnLatency = {
      turnId: this.turnId,
      eosAt: eos,
      sttFinalAt: this.sttFinalAt,
      llmFirstTokenAt: this.llmFirstTokenAt,
      firstChunkAt: this.firstChunkAt,
      firstAudioAt: this.firstAudioAt,
      replyDoneAt: this.replyDoneAt,

      eosToSttFinalMs: delta(eos, this.sttFinalAt),
      sttFinalToTtftMs: delta(this.sttFinalAt, this.llmFirstTokenAt),
      ttftToFirstAudioMs: delta(this.llmFirstTokenAt, this.firstAudioAt),
      eosToFirstAudioMs: delta(eos, this.firstAudioAt),
      totalTurnMs: delta(eos, this.replyDoneAt),
    };

    return result;
  }

  /**
   * Return budget violations as human-readable strings (empty array = within budget).
   */
  checkBudget(latency: TurnLatency): string[] {
    const violations: string[] = [];
    const check = (
      value: number | null,
      threshold: number,
      label: string,
    ) => {
      if (value !== null && value > threshold) {
        violations.push(`${label}: ${value}ms > ${threshold}ms budget`);
      }
    };

    check(latency.eosToSttFinalMs, this.thresholds.eosToSttFinalWarnMs, "EOS→STT");
    check(latency.sttFinalToTtftMs, this.thresholds.sttFinalToTtftWarnMs, "STT→TTFT");
    check(latency.ttftToFirstAudioMs, this.thresholds.ttftToFirstAudioWarnMs, "TTFT→audio");
    check(latency.eosToFirstAudioMs, this.thresholds.eosToFirstAudioWarnMs, "EOS→audio");

    return violations;
  }
}

/** Convenience: compute latency from a set of raw timestamps. */
export function computeLatency(params: {
  turnId: string;
  eosAt: number;
  sttFinalAt?: number;
  llmFirstTokenAt?: number;
  firstAudioAt?: number;
  replyDoneAt?: number;
}): TurnLatency {
  const tracker = new TurnLatencyTracker(params.turnId);
  tracker.markEos(params.eosAt);
  if (params.sttFinalAt !== undefined) tracker.markSttFinal(params.sttFinalAt);
  if (params.llmFirstTokenAt !== undefined) tracker.markLlmFirstToken(params.llmFirstTokenAt);
  if (params.firstAudioAt !== undefined) tracker.markFirstAudio(params.firstAudioAt);
  if (params.replyDoneAt !== undefined) tracker.markReplyDone(params.replyDoneAt);
  return tracker.finish();
}
