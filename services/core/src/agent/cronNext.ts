/**
 * parseCronNext — computes the next epoch-ms occurrence of a cron expression,
 * strictly after `after`.
 *
 * This is the missing seam identified in 11-RESEARCH.md's critical finding:
 * `createAgentSystem({...})` never supplied a `parseCronNext` implementation,
 * so `services/agent/src/proactive/scheduler.ts`'s `armCron()`/`catchUp()`
 * silently no-op (`if (!t.cron || !this.opts.parseCronNext) return;`) and NO
 * cron trigger has ever fired live.
 *
 * Inverted from `@jarvis/integrations`' `isDue()` (boolean "is it due now")
 * (services/integrations/src/framework/scheduler.ts:35-91) into "what's the
 * next occurrence" — same 5-part guard, same pattern detection, same UTC
 * anchoring — but the per-source pseudo-random offset `isDue` adds is
 * deliberately NOT reproduced here: that offset is a per-connector sync
 * concern for `@jarvis/integrations`, not something system cron triggers
 * (consolidation, briefing, future sync jobs) need.
 *
 * Supports exactly the 3 patterns every trigger this system needs:
 *   - '*\/N * * * *'  — every N minutes
 *   - 'M * * * *'     — hourly at minute M
 *   - 'M H * * *'     — daily at H:M UTC
 *
 * `tz` is accepted for signature compatibility with the injection point
 * (`AgentSystemConfig.parseCronNext` / `SchedulerOptions.parseCronNext`) but
 * only "UTC" is honored — every trigger this phase and the existing two jobs
 * (nightly-consolidation, morning-briefing) use `timezone: "UTC"`. Full
 * IANA-timezone/DST-aware parsing is deliberately out of scope (would need
 * the `cron-parser` npm package, rejected per this phase's zero-new-deps
 * constraint — see 11-RESEARCH.md Assumption A1); revisit if/when a future
 * phase adds user-facing local-time recurring reminders.
 *
 * Semantics: every branch returns a timestamp STRICTLY GREATER than `after`
 * (never `>=`) — this matches the fake `parseCronNext` used throughout
 * services/agent/test/scheduler.test.ts:
 *   `missedTimes.find((t) => t > after)`
 * An off-by-one here (using `>=` instead of `>`) re-introduces the exact
 * never-arm / double-fire scheduler defect this phase exists to fix.
 */
export function parseCronNext(
  expr: string,
  _tz: string,
  after: number = Date.now(),
): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour] = parts;

  // '*/N * * * *' — interval: smallest epoch-anchored multiple of N minutes
  // strictly greater than `after`.
  if (minute?.startsWith("*/")) {
    const intervalMin = parseInt(minute.slice(2), 10);
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) return null;
    const periodMs = intervalMin * 60_000;
    return Math.ceil((after + 1) / periodMs) * periodMs;
  }

  const targetMin = parseInt(minute ?? "0", 10);
  if (Number.isNaN(targetMin)) return null;

  // 'M * * * *' — hourly at minute M: this hour's :M if strictly after
  // `after`, else next hour's :M.
  if (hour === "*") {
    const hourStart = new Date(after);
    hourStart.setUTCMinutes(0, 0, 0);
    let candidate = hourStart.getTime() + targetMin * 60_000;
    if (candidate <= after) {
      candidate += 60 * 60_000;
    }
    return candidate;
  }

  const targetHour = parseInt(hour ?? "0", 10);
  if (Number.isNaN(targetHour)) return null;

  // 'M H * * *' — daily at H:M UTC: today's H:M if strictly after `after`,
  // else tomorrow's H:M. Date's UTC setters/arithmetic handle month/year
  // rollover automatically, so no special-casing is needed here.
  const todayTarget = new Date(after);
  todayTarget.setUTCHours(targetHour, targetMin, 0, 0);
  let candidate = todayTarget.getTime();
  if (candidate <= after) {
    candidate += 24 * 60 * 60 * 1000;
  }
  return candidate;
}
