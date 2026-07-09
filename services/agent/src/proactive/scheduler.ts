/**
 * Proactive scheduler (feature 19).
 *
 * Responsibilities:
 *   1. On start: catch-up on missed cron runs (machine was asleep/off).
 *   2. Arm timers for due cron triggers.
 *   3. Subscribe to event triggers on the internal bus.
 *   4. Poll condition triggers on their cadence (debounce + cooldown).
 *   5. Acquire per-trigger advisory LOCK before each run to prevent overlap.
 *   6. Wake agent or run deterministic ScheduledJob per trigger action.
 *   7. Persist EpisodicState + TriggerRun after each run.
 *   8. Release lock and recompute nextRunAt.
 *
 * The deterministic core owns the clock, locks, catch-up, and debounce.
 * The only AI is the AgentRunner woken in step 6 for agent-goal triggers.
 *
 * NOTE: This implementation uses setInterval + setTimeout to approximate cron.
 * In production, replace the cron tick with a real cron-parser (DST-aware).
 * The cron expression parser is injected as `parseCronNext` for testability.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Trigger,
  TriggerRun,
  EpisodicState,
  ScheduledJob,
  TriggerContext,
  JobResult,
  Clock,
  LlmClient,
  ToolRegistry,
  UserContextProvider,
} from "../types.js";
import { TriggerStore } from "./triggers.js";
import { EpisodicStateStore } from "./episodicState.js";
import { AgentRunner } from "../core/agent.js";
import type { Checkpointer } from "../core/checkpointer.js";
import type { ApprovalService } from "../safety/approval.js";
import type { AuditLog } from "../safety/audit.js";

const RUN_DDL = `
CREATE TABLE IF NOT EXISTS trigger_runs (
  id           TEXT PRIMARY KEY,
  trigger_id   TEXT NOT NULL,
  fired_at     TEXT NOT NULL,
  fired_by     TEXT NOT NULL,
  status       TEXT NOT NULL,
  ran_as       TEXT NOT NULL,  -- JSON
  context_summary TEXT NOT NULL,
  result       TEXT,           -- JSON
  error        TEXT,           -- JSON
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  scheduled_for TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_trigger ON trigger_runs (trigger_id, fired_at DESC);
`;

const MIN_INTERVAL_SEC = 5; // runaway floor

// Per-trigger advisory lock
const locks = new Map<string, boolean>();

function acquireLock(triggerId: string): boolean {
  if (locks.get(triggerId)) return false;
  locks.set(triggerId, true);
  return true;
}

function releaseLock(triggerId: string): void {
  locks.delete(triggerId);
}

/**
 * Comparison operators a condition predicate may use, e.g. "< 33" or ">= 0".
 * "=" and "==" are aliases for strict equality.
 */
const PREDICATE_COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "=": (a, b) => a === b,
  "==": (a, b) => a === b,
};

export interface SchedulerOptions {
  dataDir: string;
  clock: Clock;
  llm: LlmClient;
  tools: ToolRegistry;
  /**
   * SHARED safety/persistence instances — the same objects used by the rest
   * of the agent system. The Scheduler must NOT construct its own: two
   * AuditLog instances over the same file cache latestSeq/latestHash in
   * memory and the second writer throws on the PRIMARY KEY constraint; a
   * private ApprovalService would create requests nobody can approve through
   * the public system.approvals.
   */
  auditLog: AuditLog;
  approvalService: ApprovalService;
  checkpointer: Checkpointer;
  /** DST-aware cron next-fire parser. Returns ms-since-epoch for next occurrence. */
  parseCronNext?: (expr: string, tz: string, after?: number) => number | null;
  /** Optional event bus */
  eventBus?: EventBus;
  /** Feature 20: optional profile-context provider for agent-goal triggers. */
  userContext?: UserContextProvider;
}

export interface EventBus {
  on(topic: string, handler: (payload: unknown) => void): void;
  emit(topic: string, payload: unknown): void;
}

export class Scheduler {
  private triggerStore: TriggerStore;
  private episodicStore: EpisodicStateStore;
  private runDb: DatabaseSync;
  private jobs = new Map<string, ScheduledJob>();
  private agentRunner: AgentRunner;
  private approvalService: ApprovalService;
  private auditLog: AuditLog;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private opts: SchedulerOptions;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    mkdirSync(opts.dataDir, { recursive: true });

    this.triggerStore = new TriggerStore(opts.dataDir);
    this.episodicStore = new EpisodicStateStore(opts.dataDir);

    this.runDb = new DatabaseSync(join(opts.dataDir, "trigger_runs.db"));
    this.runDb.exec("PRAGMA journal_mode=WAL");
    this.runDb.exec(RUN_DDL);

    // Shared instances injected by createAgentSystem — never re-constructed.
    this.approvalService = opts.approvalService;
    this.auditLog = opts.auditLog;

    this.agentRunner = new AgentRunner({
      llm: opts.llm,
      tools: opts.tools,
      checkpointer: opts.checkpointer,
      approvalService: this.approvalService,
      auditLog: this.auditLog,
      clock: opts.clock,
      userContext: opts.userContext,
    });
  }

  registerJob(job: ScheduledJob): void {
    this.jobs.set(job.name, job);
  }

  /**
   * Start the scheduler: catch-up + arm triggers.
   */
  async start(): Promise<void> {
    await this.catchUp();
    const triggers = this.triggerStore.list({ enabled: true });
    for (const t of triggers) {
      this.armTrigger(t);
    }
  }

  /**
   * Stop all timers/intervals.
   */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const interval of this.intervals.values()) clearInterval(interval);
    this.timers.clear();
    this.intervals.clear();
  }

  /**
   * Add a new trigger to the store and arm it.
   */
  addTrigger(
    trigger: Omit<Trigger, "id" | "createdAt" | "updatedAt" | "status">,
  ): Trigger {
    const t = this.triggerStore.create(trigger, this.opts.clock.isoNow());
    this.armTrigger(t);
    return t;
  }

  /**
   * Manually fire a trigger (for testing / catch-up).
   */
  async fireTrigger(
    triggerId: string,
    firedBy: TriggerRun["firedBy"] = "manual",
    scheduledFor?: string,
  ): Promise<TriggerRun> {
    const trigger = this.triggerStore.get(triggerId);
    if (!trigger) throw new Error(`Trigger not found: ${triggerId}`);
    return this.fire(trigger, firedBy, scheduledFor);
  }

  /** Expose trigger store for tests. */
  get triggers(): TriggerStore {
    return this.triggerStore;
  }

  /** Expose episodic store for tests. */
  get episodic(): EpisodicStateStore {
    return this.episodicStore;
  }

  // ── Internal: catch-up ────────────────────────────────────────────────────

  private async catchUp(): Promise<void> {
    const cronTriggers = this.triggerStore.list({ enabled: true, kind: "cron" });
    const now = this.opts.clock.now();

    for (const t of cronTriggers) {
      if (!t.lastRunAt || !t.cron) continue;

      const lastRun = new Date(t.lastRunAt).getTime();
      const missed = this.computeMissedOccurrences(
        t.cron.expr,
        t.cron.timezone,
        lastRun,
        now,
      );

      if (missed.length === 0) continue;

      const policy = t.catchUp;
      if (policy === "skip") {
        // Just realign nextRunAt — no runs
        continue;
      }

      const toRun = policy === "run-once" ? [missed[0]!] : missed;
      for (const scheduledFor of toRun) {
        await this.fireLocked(t, "catch-up", new Date(scheduledFor).toISOString());
      }
    }
  }

  /**
   * Simple missed-occurrence computation.
   * Returns timestamps of missed occurrences between lastRunAt and now.
   */
  private computeMissedOccurrences(
    expr: string,
    tz: string,
    lastRunMs: number,
    nowMs: number,
  ): number[] {
    const missed: number[] = [];
    if (!this.opts.parseCronNext) return missed;

    let cursor = lastRunMs;
    while (true) {
      const next = this.opts.parseCronNext(expr, tz, cursor);
      if (next === null || next >= nowMs) break;
      missed.push(next);
      cursor = next + 1000;
      if (missed.length > 100) break; // safety cap
    }
    return missed;
  }

  // ── Internal: arm a single trigger ───────────────────────────────────────

  private armTrigger(t: Trigger): void {
    if (t.kind === "cron") {
      this.armCron(t);
    } else if (t.kind === "event" && this.opts.eventBus) {
      this.armEvent(t);
    } else if (t.kind === "condition") {
      this.armCondition(t);
    }
  }

  private armCron(t: Trigger): void {
    if (!t.cron || !this.opts.parseCronNext) return;

    // Idempotent re-arm (11-01 fix): addTrigger() arms immediately, and
    // start() unconditionally re-arms every enabled trigger — without this
    // guard, a trigger added then started ends up with TWO live setTimeout
    // timers (the advisory lock in fireLocked() keeps double-fire from
    // happening, but the leaked timer still fires and wastes a cycle, and
    // repeated start()/re-arm cycles compound the leak). Clear any existing
    // armed timer for this trigger id before arming a new one so arming is
    // last-write-wins idempotent.
    const existingTimer = this.timers.get(t.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timers.delete(t.id);
    }

    const nextMs = this.opts.parseCronNext(
      t.cron.expr,
      t.cron.timezone,
      this.opts.clock.now(),
    );
    if (nextMs === null) return;

    const delay = Math.max(0, nextMs - this.opts.clock.now());
    const timer = setTimeout(async () => {
      this.timers.delete(t.id);
      const current = this.triggerStore.get(t.id);
      if (!current?.enabled) return;

      await this.fireLocked(t, "cron", new Date(nextMs).toISOString());

      // Re-arm (unless one-shot)
      if (!t.cron?.oneShot) {
        const updated = this.triggerStore.get(t.id);
        if (updated?.enabled) this.armCron(updated);
      } else {
        this.triggerStore.disable(t.id, this.opts.clock.isoNow());
      }
    }, delay);

    this.timers.set(t.id, timer);
  }

  private armEvent(t: Trigger): void {
    if (!t.event || !this.opts.eventBus) return;
    this.opts.eventBus.on(t.event.topic, async (payload) => {
      if (t.event?.filter && !matchesFilter(payload, t.event.filter)) return;
      const current = this.triggerStore.get(t.id);
      if (!current?.enabled) return;

      await this.fireLocked(t, "event");
    });
  }

  private armCondition(t: Trigger): void {
    if (!t.condition) return;
    const condition = t.condition;
    const pollMs = Math.max(condition.pollEverySec, MIN_INTERVAL_SEC) * 1000;

    // Timestamp at which the predicate first started holding continuously, or
    // null when it isn't currently held. The trigger fires only once the
    // predicate has held for at least debounceSec — this suppresses flapping.
    let heldSince: number | null = null;

    const interval = setInterval(async () => {
      const current = this.triggerStore.get(t.id);
      if (!current?.enabled) return;

      if (this.inCooldown(t.id)) return;

      const value = await this.evaluateCondition(condition.metric, condition.predicate);
      if (!value.satisfied) {
        heldSince = null; // predicate dropped — restart the debounce window
        return;
      }

      const now = this.opts.clock.now();
      if (heldSince === null) heldSince = now;
      if (now - heldSince < condition.debounceSec * 1000) return; // still debouncing

      // Debounce satisfied — attempt to fire. fireLocked returns null if a
      // previous fire is still in flight; cooldown starts only on a real fire.
      heldSince = null;
      const fired = await this.fireLocked(t, "condition");
      if (!fired) return;

      this.episodicStore.updateConditionState(t.id, {
        lastValue: value.currentValue,
        crossedAt: this.opts.clock.isoNow(),
        cooldownUntil: new Date(
          this.opts.clock.now() + condition.cooldownSec * 1000,
        ).toISOString(),
      });
    }, pollMs);

    this.intervals.set(t.id, interval);
  }

  /** True if this condition trigger is still within its post-fire cooldown. */
  private inCooldown(triggerId: string): boolean {
    const cooldownUntil = this.episodicStore.read(triggerId).conditionState?.cooldownUntil;
    if (!cooldownUntil) return false;
    return this.opts.clock.now() < new Date(cooldownUntil).getTime();
  }

  /**
   * Evaluate a condition metric + predicate.
   * Stub: in production, queries feature 13/10/11 metric sources.
   */
  private async evaluateCondition(
    metric: string,
    predicate: string,
  ): Promise<{ satisfied: boolean; currentValue?: number }> {
    // Parse predicate like "< 33" or "> 0"
    const match = predicate.match(/^([<>]=?|==?)\s*(\d+(?:\.\d+)?)$/);
    if (!match) return { satisfied: false };

    const compare = PREDICATE_COMPARATORS[match[1]!];
    if (!compare) return { satisfied: false };
    const threshold = parseFloat(match[2]!);

    // In production: look up the metric value from injected metric source
    // For now, this is a testable stub — use injected metric provider if available
    const metricValue = await this.getMetricValue(metric);
    if (metricValue === null) return { satisfied: false };

    return { satisfied: compare(metricValue, threshold), currentValue: metricValue };
  }

  /** Injectable metric provider (override in tests). */
  metricProvider?: (metric: string) => Promise<number | null>;

  private async getMetricValue(metric: string): Promise<number | null> {
    if (this.metricProvider) {
      return this.metricProvider(metric);
    }
    return null;
  }

  // ── Internal: execute a trigger ──────────────────────────────────────────

  /**
   * Fire under the per-trigger advisory lock. Returns null (without firing)
   * when a previous fire for this trigger is still in flight.
   */
  private async fireLocked(
    trigger: Trigger,
    firedBy: TriggerRun["firedBy"],
    scheduledFor?: string,
  ): Promise<TriggerRun | null> {
    if (!acquireLock(trigger.id)) return null;
    try {
      return await this.fire(trigger, firedBy, scheduledFor);
    } finally {
      releaseLock(trigger.id);
    }
  }

  private async fire(
    trigger: Trigger,
    firedBy: TriggerRun["firedBy"],
    scheduledFor?: string,
  ): Promise<TriggerRun> {
    const runId = randomUUID();
    const now = this.opts.clock.isoNow();

    const ranAs: TriggerRun["ranAs"] =
      "job" in trigger.action
        ? { job: trigger.action.job }
        : { agentRunId: "" }; // updated after agent run

    const run: TriggerRun = {
      id: runId,
      triggerId: trigger.id,
      firedAt: now,
      firedBy,
      status: "running",
      ranAs,
      contextSummary: "",
      startedAt: now,
      scheduledFor,
    };

    this.saveRun(run);
    this.triggerStore.setStatus(trigger.id, "running", now);

    try {
      const episodic = this.episodicStore.read(trigger.id);
      const ctx: TriggerContext = {
        trigger,
        episodic,
        inputs: scheduledFor ? { scheduledFor } : { firedBy },
        firedAt: now,
        firedBy,
      };
      run.contextSummary = `trigger=${trigger.name} firedBy=${firedBy}`;

      let result: unknown;
      let episodicUpdate: Partial<EpisodicState> = {};

      if ("job" in trigger.action) {
        const job = this.jobs.get(trigger.action.job);
        if (!job) throw new Error(`Job not found: ${trigger.action.job}`);

        const jobResult = await withTimeout(
          job.handler(ctx),
          job.maxDurationSec * 1000,
          "Job timeout",
        );

        result = jobResult;
        if (jobResult.episodicUpdate) {
          episodicUpdate = jobResult.episodicUpdate;
        }
      } else {
        // Wake the agent as a REASONER
        const agentResult = await this.agentRunner.run(
          trigger.action.agentGoal,
          { source: "scheduler" },
        );
        result = agentResult.run.result;
        run.ranAs = { agentRunId: agentResult.run.id };
        episodicUpdate = {
          lastDecision: `agent run ${agentResult.run.id}: status=${agentResult.run.status}`,
        };

        if (agentResult.run.status === "awaiting-approval") {
          run.status = "awaiting-approval";
        }
      }

      // Persist episodic state
      const updated: EpisodicState = {
        ...episodic,
        ...episodicUpdate,
        lastFiredAt: now,
        runHistoryRefs: [...episodic.runHistoryRefs, runId].slice(-20),
        updatedAt: now,
      };
      this.episodicStore.write(trigger.id, updated);

      if (run.status !== "awaiting-approval") {
        run.status = "done";
      }
      run.result = result;
      run.finishedAt = this.opts.clock.isoNow();
    } catch (err) {
      run.status = "failed";
      run.error = {
        code: "run-error",
        message: err instanceof Error ? err.message : String(err),
      };
      run.finishedAt = this.opts.clock.isoNow();
    }

    this.saveRun(run);
    this.triggerStore.setStatus(trigger.id, "scheduled", this.opts.clock.isoNow());
    this.triggerStore.bumpLastRun(trigger.id, runId, undefined, this.opts.clock.isoNow());

    return run;
  }

  // ── Run persistence ───────────────────────────────────────────────────────

  private saveRun(run: TriggerRun): void {
    this.runDb
      .prepare(
        `INSERT OR REPLACE INTO trigger_runs
         (id, trigger_id, fired_at, fired_by, status, ran_as, context_summary, result, error, started_at, finished_at, scheduled_for)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.triggerId,
        run.firedAt,
        run.firedBy,
        run.status,
        JSON.stringify(run.ranAs),
        run.contextSummary,
        run.result !== undefined ? JSON.stringify(run.result) : null,
        run.error ? JSON.stringify(run.error) : null,
        run.startedAt,
        run.finishedAt ?? null,
        run.scheduledFor ?? null,
      );
  }

  getRun(runId: string): TriggerRun | undefined {
    const row = this.runDb
      .prepare(`SELECT * FROM trigger_runs WHERE id = ?`)
      .get(runId) as TriggerRunRow | undefined;

    return row ? rowToTriggerRun(row) : undefined;
  }

  listRuns(triggerId: string): TriggerRun[] {
    const rows = this.runDb
      .prepare(
        `SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY fired_at DESC LIMIT 50`,
      )
      .all(triggerId) as unknown as TriggerRunRow[];

    return rows.map(rowToTriggerRun);
  }
}

interface TriggerRunRow {
  id: string;
  trigger_id: string;
  fired_at: string;
  fired_by: string;
  status: string;
  ran_as: string;
  context_summary: string;
  result: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  scheduled_for: string | null;
}

function rowToTriggerRun(row: TriggerRunRow): TriggerRun {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    firedAt: row.fired_at,
    firedBy: row.fired_by as TriggerRun["firedBy"],
    status: row.status as TriggerRun["status"],
    ranAs: JSON.parse(row.ran_as) as TriggerRun["ranAs"],
    contextSummary: row.context_summary,
    result: row.result ? (JSON.parse(row.result) as unknown) : undefined,
    error: row.error
      ? (JSON.parse(row.error) as { code: string; message: string })
      : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    scheduledFor: row.scheduled_for ?? undefined,
  };
}

function matchesFilter(
  payload: unknown,
  filter: Record<string, unknown>,
): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return Object.entries(filter).every(([k, v]) => p[k] === v);
}

/**
 * Race a promise against a wall-clock timeout. Uses the real timer (not the
 * injected Clock) so a hung job handler cannot stall the scheduler even when
 * tests drive a frozen clock. Rejects with `timeoutMessage` if it wins.
 */
function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
    ),
  ]);
}
