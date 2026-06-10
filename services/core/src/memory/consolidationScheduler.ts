/**
 * ConsolidationScheduler — runs memory consolidation in the background so
 * captured turns get promoted into the retrievable graph without a manual step.
 *
 * Retrieval only searches the *consolidated* memory graph (see CLAUDE.md / the
 * memory note in features/2). Capture alone isn't enough for cross-session
 * recall — consolidation has to run. `npm run core` doesn't run the nightly
 * scheduler, so this is the lightweight in-process trigger that makes "tell it
 * something → it remembers later" actually work.
 *
 * Policy (cheap, single-user friendly — consolidation calls the HF model, so we
 * don't want to run it on every turn):
 *   - poll every `intervalMs`;
 *   - run when capture activity has gone **quiet** (pending count unchanged
 *     since the last tick → the user stopped adding) OR a **burst** has
 *     accumulated (>= `burstThreshold` pending records);
 *   - never run two consolidations concurrently.
 */
import type { MemorySystem } from "@jarvis/memory";

type ConsolidationResult = Awaited<
  ReturnType<MemorySystem["consolidation"]["run"]>
>;

export interface ConsolidationSchedulerOptions {
  /** Poll interval in ms. Default 60_000 (1 min). */
  intervalMs?: number;
  /** Run immediately once this many records are pending. Default 25. */
  burstThreshold?: number;
  /** Log sink. Default stderr. */
  log?: (msg: string) => void;
}

export class ConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private prevPending = -1;
  private readonly intervalMs: number;
  private readonly burstThreshold: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly memory: MemorySystem,
    opts: ConsolidationSchedulerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.burstThreshold = opts.burstThreshold ?? 25;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  /** Begin background polling. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Don't keep the process alive solely for this timer.
    this.timer.unref?.();
    this.log(
      `[consolidation] scheduler started (every ${Math.round(this.intervalMs / 1000)}s)`,
    );
  }

  /** Stop background polling. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scheduling decision (+ maybe a run). Exposed for tests so the policy
   * can be exercised without real timers.
   */
  async tick(): Promise<void> {
    if (this.running) return;

    let pending: number;
    try {
      pending = this.memory.store.getPendingExperienceRecords().length;
    } catch {
      return; // store unavailable — try again next tick
    }

    if (pending === 0) {
      this.prevPending = 0;
      return;
    }

    const quiet = pending === this.prevPending; // unchanged since last tick
    const burst = pending >= this.burstThreshold;
    this.prevPending = pending;

    if (quiet || burst) {
      await this.runNow("scheduler");
    }
    // else: still actively capturing — let it settle until the next tick.
  }

  /**
   * Run consolidation now (used by the manual /consolidate endpoint too).
   * Returns the result, or null if a run is already in flight.
   */
  async runNow(
    trigger: "scheduler" | "manual",
  ): Promise<ConsolidationResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const res = await this.memory.consolidation.run(trigger);
      const c = res.run?.counts;
      this.log(
        `[consolidation] ${trigger} run: processed=${c?.recordsProcessed ?? "?"} factsExtracted=${c?.factsExtracted ?? "?"}`,
      );
      this.prevPending = 0;
      return res;
    } catch (err) {
      this.log(
        `[consolidation] run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }
}
