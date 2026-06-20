/**
 * proactiveBootstrap — registers default triggers on the agent's scheduler:
 *
 *   1. nightly-consolidation (cron 03:00 UTC daily)
 *      Calls memory.consolidation.run() to compact and deduplicate memories.
 *
 *   2. morning-briefing (cron 07:00 UTC daily)
 *      Calls integrations.briefing.assembleBriefing() and stores the result
 *      in the EpisodicState for the trigger so the dashboard can surface it.
 *
 *   Condition triggers' metricProvider is wired to integrations.metrics via
 *   metric polling in the condition action handlers.
 *
 * Usage:
 *   startProactive() — called by the daemon; idempotent.
 *
 * Tests fire triggers manually via scheduler.fireTrigger(triggerId, 'manual').
 * Live cron timers are NOT started in this module — call scheduler.start() from
 * the daemon entry point if you want live scheduling.
 */

import type { AgentSystem } from "@jarvis/agent";
import type { IntegrationsSystem } from "@jarvis/integrations";
import type { MemorySystem } from "@jarvis/memory";

let bootstrapped = false;
const registeredTriggerIds: { consolidation?: string; briefing?: string } = {};

/** Normalize a thrown value to a string message for job-failure summaries. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ProactiveBootstrapDeps {
  agentSystem: AgentSystem;
  integrations: Pick<IntegrationsSystem, "briefing" | "metrics">;
  memory: Pick<MemorySystem, "consolidation">;
}

/**
 * Register default proactive triggers on the scheduler.
 * Jobs are registered by name so the scheduler's job registry can call them.
 *
 * Idempotent — subsequent calls are no-ops.
 * Does NOT start live cron timers; call agentSystem.triggers.start() separately.
 */
export function registerProactiveTriggers(deps: ProactiveBootstrapDeps): {
  consolidationTriggerId: string;
  briefingTriggerId: string;
} {
  if (bootstrapped) {
    return {
      consolidationTriggerId: registeredTriggerIds.consolidation ?? "",
      briefingTriggerId: registeredTriggerIds.briefing ?? "",
    };
  }
  bootstrapped = true;

  const { agentSystem, integrations, memory } = deps;
  const { triggers } = agentSystem;

  // ── 1. Register the consolidation ScheduledJob ──────────────────────────────
  triggers.registerJob({
    name: "nightly-consolidation",
    description: "Compact and deduplicate memory store nightly.",
    needsModel: "hf",
    maxDurationSec: 300,
    singleton: true,

    async handler(_ctx) {
      try {
        const result = await memory.consolidation.run("scheduler");
        return {
          status: "done",
          summary: `Consolidation complete: ${JSON.stringify(result)}`,
          episodicUpdate: {
            lastDecision: `consolidation:${new Date().toISOString()}`,
          },
        };
      } catch (err) {
        const message = errMsg(err);
        return {
          status: "failed",
          summary: `Consolidation failed: ${message}`,
          error: { code: "consolidation-error", message },
        };
      }
    },
  });

  // ── 2. Register the briefing ScheduledJob ────────────────────────────────────
  triggers.registerJob({
    name: "morning-briefing",
    description: "Assemble the daily morning briefing.",
    needsModel: "hf",
    maxDurationSec: 120,
    singleton: true,

    async handler(ctx) {
      try {
        const briefing = await integrations.briefing.assembleBriefing();
        return {
          status: "done",
          summary: `Briefing assembled: ${briefing.markdown?.slice(0, 100) ?? "(no markdown)"}`,
          episodicUpdate: {
            lastDecision: `briefing:${new Date().toISOString()}`,
            // Store the briefing in open follow-ups so downstream can surface it
            openFollowUps: [
              {
                id: `briefing-${Date.now()}`,
                text: briefing.markdown ?? "Morning briefing ready",
                sinceRunId: ctx.trigger.id,
              },
            ],
          },
        };
      } catch (err) {
        const message = errMsg(err);
        return {
          status: "failed",
          summary: `Briefing failed: ${message}`,
          error: { code: "briefing-error", message },
        };
      }
    },
  });

  // ── 3. Add cron triggers to the scheduler store ──────────────────────────────

  const consolidationTrigger = triggers.addTrigger({
    name: "nightly-consolidation",
    kind: "cron",
    enabled: true,
    cron: { expr: "0 3 * * *", timezone: "UTC" },
    action: { job: "nightly-consolidation" },
    tags: ["memory", "maintenance"],
    catchUp: "run-once",
  });

  const briefingTrigger = triggers.addTrigger({
    name: "morning-briefing",
    kind: "cron",
    enabled: true,
    cron: { expr: "0 7 * * *", timezone: "UTC" },
    action: { job: "morning-briefing" },
    tags: ["briefing", "daily"],
    catchUp: "skip",
  });

  registeredTriggerIds.consolidation = consolidationTrigger.id;
  registeredTriggerIds.briefing = briefingTrigger.id;

  return {
    consolidationTriggerId: consolidationTrigger.id,
    briefingTriggerId: briefingTrigger.id,
  };
}

/**
 * startProactive — call from the daemon after wiring all subsystems.
 * Registers triggers (idempotent) and starts the scheduler's cron timers.
 */
export function startProactive(deps: ProactiveBootstrapDeps): void {
  registerProactiveTriggers(deps);
  // Intentionally NOT calling triggers.start() here — the daemon can do that
  // after startProactive() to decouple registration from timer management.
  // In tests, triggers are fired manually via triggers.fireTrigger().
}

/** Reset bootstrap state (used in tests). */
export function resetProactiveBootstrap(): void {
  bootstrapped = false;
  registeredTriggerIds.consolidation = undefined;
  registeredTriggerIds.briefing = undefined;
}
