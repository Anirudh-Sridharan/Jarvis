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
 *   3. sync-connectors (cron every 15 min UTC)
 *      Runs due connector syncs (whoop/gcal/gmail/github) via
 *      integrations.scheduler.getDueConnectors/runSync with trigger="schedule".
 *      Skips a source whose most recent sync_runs row is still "running" —
 *      cheap belt-and-suspenders guard against racing a manual CLI sync of
 *      the same source (Whoop's rotating refresh token is not safe under
 *      concurrency — see 11-RESEARCH.md Pitfall 3).
 *
 *   4. sync-captures (cron hourly UTC)
 *      Ingests the Obsidian vault / local documents / email into memory via
 *      runVaultIngest/runFilesIngest/runEmailIngest. Each source is
 *      independently try/caught — runEmailIngest's email.search() throws on
 *      missing/expired Gmail auth, unlike vault/files, which degrade
 *      internally (see 11-RESEARCH.md Pitfall 4).
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
import type { HttpClient, IntegrationsSystem, TokenStore } from "@jarvis/integrations";
import type { MemorySystem } from "@jarvis/memory";
import { runVaultIngest } from "../memory/vaultIngest.js";
import { runFilesIngest } from "../memory/filesIngest.js";
import { runEmailIngest } from "../memory/emailIngest.js";

let bootstrapped = false;
const registeredTriggerIds: {
  consolidation?: string;
  briefing?: string;
  syncConnectors?: string;
  syncCaptures?: string;
} = {};

/** Normalize a thrown value to a string message for job-failure summaries. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ProactiveBootstrapDeps {
  agentSystem: AgentSystem;
  integrations: Pick<IntegrationsSystem, "briefing" | "metrics" | "connectors" | "scheduler" | "email">;
  memory: Pick<MemorySystem, "consolidation" | "capture">;
  http: HttpClient;
  tokenStore: TokenStore;
  /** Filesystem sources for sync-captures; unset paths are skipped. */
  capturePaths: { vaultDir?: string; filesDir?: string };
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
  syncConnectorsTriggerId: string;
  syncCapturesTriggerId: string;
} {
  if (bootstrapped) {
    return {
      consolidationTriggerId: registeredTriggerIds.consolidation ?? "",
      briefingTriggerId: registeredTriggerIds.briefing ?? "",
      syncConnectorsTriggerId: registeredTriggerIds.syncConnectors ?? "",
      syncCapturesTriggerId: registeredTriggerIds.syncCaptures ?? "",
    };
  }
  bootstrapped = true;

  const { agentSystem, integrations, memory, http, tokenStore, capturePaths } = deps;
  const { triggers } = agentSystem;

  // ── 1. Register the consolidation ScheduledJob ──────────────────────────────
  triggers.registerJob({
    name: "nightly-consolidation",
    description: "Compact and deduplicate memory store nightly.",
    needsModel: "cloud",
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
    needsModel: "cloud",
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

  // ── 3. Register the sync-connectors ScheduledJob ─────────────────────────────
  triggers.registerJob({
    name: "sync-connectors",
    description: "Run due connector syncs (whoop/gcal/gmail/github).",
    needsModel: "none",
    maxDurationSec: 180,
    singleton: true,

    async handler(_ctx) {
      try {
        const due = integrations.scheduler.getDueConnectors(integrations.connectors.list());
        const results: string[] = [];
        // WR-08: track outcomes STRUCTURALLY (SyncRun.status), not by
        // substring-matching human-readable messages — a connector failing on
        // every cron run must not be recorded as a successful job.
        const runStatuses: string[] = [];
        for (const connector of due) {
          // Belt-and-suspenders pre-flight (Pitfall 3): skip if a run for this
          // source is already in flight — covers the cross-process race with a
          // manually-spawned CLI sync (Whoop's rotating refresh token is NOT
          // safe under concurrency).
          const [last] = integrations.scheduler.listRuns(connector.id, 1);
          if (last && last.status === "running") {
            results.push(`${connector.id}: skipped (already running)`);
            continue;
          }
          const run = await integrations.scheduler.runSync(connector, http, tokenStore, "schedule");
          runStatuses.push(run.status);
          results.push(`${connector.id}: ${run.status}`);
        }
        const failed = runStatuses.filter((s) => s === "error").length;
        const status =
          failed === 0 ? "done" : failed === runStatuses.length ? "failed" : "partial";
        return {
          status,
          summary: results.join("; ") || "nothing due",
          episodicUpdate: { lastDecision: `sync-connectors:${new Date().toISOString()}` },
        };
      } catch (err) {
        const message = errMsg(err);
        return {
          status: "failed",
          summary: `sync-connectors failed: ${message}`,
          error: { code: "sync-connectors-error", message },
        };
      }
    },
  });

  // ── 4. Register the sync-captures ScheduledJob ───────────────────────────────
  triggers.registerJob({
    name: "sync-captures",
    description: "Ingest obsidian vault, local documents, and email into memory.",
    needsModel: "none",
    maxDurationSec: 300,
    singleton: true,

    async handler(_ctx) {
      const notes: string[] = [];
      // WR-08: outcome booleans set in each catch — never substring-match the
      // human-readable notes. An EXPECTED unconfigured source (no vault/files
      // path, gmail not connected) is a skip, not a failure: a machine with no
      // Gmail consent must report "done", not "partial" forever.
      let anyFailed = false;
      const { vaultDir, filesDir } = capturePaths;

      if (vaultDir) {
        try {
          const r = await runVaultIngest({ memory, vaultDir });
          notes.push(`obsidian: +${r.captured} (${r.errors} errors)`);
        } catch (err) {
          anyFailed = true;
          notes.push(`obsidian: failed (${errMsg(err)})`);
        }
      }
      if (filesDir) {
        try {
          const r = await runFilesIngest({ memory, dir: filesDir });
          notes.push(`files: +${r.chunks} chunks`);
        } catch (err) {
          anyFailed = true;
          notes.push(`files: failed (${errMsg(err)})`);
        }
      }
      // Pre-flight: is Gmail even connected? (structural check against the
      // token store, mirroring how the sync path decides). Not connected =
      // expected skip; connected-but-throwing = real failure.
      const gmailConnected = Boolean(await tokenStore.get("gmail").catch(() => null));
      if (gmailConnected) {
        // runEmailIngest does NOT catch email.search() failures internally
        // (unlike vault/files, which degrade on a missing/unreadable
        // directory) — this try/catch is load-bearing (Pitfall 4).
        try {
          const r = await runEmailIngest({ memory, email: integrations.email });
          notes.push(`email: +${r.chunks} chunks`);
        } catch (err) {
          anyFailed = true;
          notes.push(`email: failed (${errMsg(err)})`);
        }
      } else {
        notes.push("email: skipped (gmail not connected)");
      }

      return {
        status: anyFailed ? "partial" : "done",
        summary: notes.join("; ") || "no sources configured",
        episodicUpdate: { lastDecision: `sync-captures:${new Date().toISOString()}` },
      };
    },
  });

  // ── 5. Add cron triggers to the scheduler store ──────────────────────────────

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

  const syncConnectorsTrigger = triggers.addTrigger({
    name: "sync-connectors",
    kind: "cron",
    enabled: true,
    cron: { expr: "*/15 * * * *", timezone: "UTC" },
    action: { job: "sync-connectors" },
    tags: ["integrations", "sync"],
    catchUp: "run-once",
  });

  const syncCapturesTrigger = triggers.addTrigger({
    name: "sync-captures",
    kind: "cron",
    enabled: true,
    cron: { expr: "0 * * * *", timezone: "UTC" },
    action: { job: "sync-captures" },
    tags: ["memory", "capture", "sync"],
    catchUp: "run-once",
  });

  registeredTriggerIds.consolidation = consolidationTrigger.id;
  registeredTriggerIds.briefing = briefingTrigger.id;
  registeredTriggerIds.syncConnectors = syncConnectorsTrigger.id;
  registeredTriggerIds.syncCaptures = syncCapturesTrigger.id;

  return {
    consolidationTriggerId: consolidationTrigger.id,
    briefingTriggerId: briefingTrigger.id,
    syncConnectorsTriggerId: syncConnectorsTrigger.id,
    syncCapturesTriggerId: syncCapturesTrigger.id,
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
  registeredTriggerIds.syncConnectors = undefined;
  registeredTriggerIds.syncCaptures = undefined;
}
