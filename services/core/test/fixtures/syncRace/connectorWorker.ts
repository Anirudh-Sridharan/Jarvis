/**
 * connectorWorker.ts — scheduled-vs-manual connector-sync race test fixture
 * (11-02 Task 2).
 *
 * Spawned as an independent OS process. Mirrors two real production call
 * sites that both drive @jarvis/integrations' Scheduler.runSync() against
 * the SAME on-disk integrations.db:
 *   - the dashboard-spawned "Sync now" CLI path (core's connect CLI
 *     `sync(source)` command) — SYNC_TRIGGER=manual
 *   - core's in-process sync-connectors scheduled job (registered by core's
 *     proactive-bootstrap wiring) — SYNC_TRIGGER=schedule
 *
 * Reads JARVIS_DATA_DIR and SYNC_TRIGGER from env, builds a leaf
 * IntegrationsSystem with fakes (FakeHttp/MemoryTokenStore — no real network/
 * Keychain needed since the fake Connector below never calls either), runs a
 * single deterministic connector sync against the shared data dir, and exits
 * 0 on success / 1 on failure (stderr carries the error for the parent to
 * assert against, e.g. no SQLITE_BUSY / "database is locked").
 *
 * The fake Connector returns a FIXED set of points + a FIXED nextCursor
 * (same values regardless of which process runs it) so the concurrent
 * upsert/cursor-advance race under test converges on the same expected
 * post-sync state no matter which process's write lands last — the race
 * being proven is "no corruption / no lock error", not "who wins".
 *
 * Imports ONLY the integrations leaf package's public API + its testing
 * fakes (never core) — the dependency-direction invariant holds even though
 * this fixture lives under services/core/test (mirrors
 * fixtures/twoWriter/coreWorker.ts's documented invariant).
 */
import {
  createIntegrations,
  type Connector,
  type ConnectorSyncResult,
} from "@jarvis/integrations";
import { FakeHttp, MemoryTokenStore } from "@jarvis/integrations/testing";

const FIXED_TS = "2026-07-09T12:00:00.000Z";
const FIXED_NEXT_CURSOR = "2026-07-09T12:00:00.000Z";

/** Deterministic fake Whoop-shaped connector — never touches the network. */
const fakeWhoopConnector: Connector = {
  id: "whoop",
  auth: "oauth",
  schedule: "0 7 * * *",
  concurrency: 1, // MUST be 1 for real Whoop — mirrored here for fidelity, unenforced by the scheduler (see 11-RESEARCH.md Pitfall 3)
  async sync(): Promise<ConnectorSyncResult> {
    return {
      points: [
        {
          id: "sync-race-fixed-point-recovery",
          source: "whoop",
          metric: "recovery.score",
          value: 65,
          unit: "%",
          ts: FIXED_TS,
          dims: {},
          ingestedAt: FIXED_TS,
          adapterVersion: "1",
        },
      ],
      nextCursor: FIXED_NEXT_CURSOR,
    };
  },
};

const unavailableLlm = {
  async complete(): Promise<string> {
    throw new Error("connectorWorker: no LLM wired — the fake connector never needs one");
  },
};

async function main(): Promise<void> {
  const dataDir = process.env.JARVIS_DATA_DIR;
  if (!dataDir) throw new Error("connectorWorker: JARVIS_DATA_DIR env var is required");

  const trigger = process.env.SYNC_TRIGGER;
  if (trigger !== "manual" && trigger !== "schedule") {
    throw new Error(`connectorWorker: SYNC_TRIGGER must be "manual" or "schedule", got "${trigger ?? ""}"`);
  }

  const http = new FakeHttp();
  const tokenStore = new MemoryTokenStore();

  const system = createIntegrations({
    http,
    clock: { now: () => Date.now() },
    tokenStore,
    llm: unavailableLlm,
    dataDir,
  });

  // Bypass getDueConnectors/the registry entirely — the race under test is
  // the concurrent WRITE to integrations.db, not due-checking (per plan).
  const run = await system.scheduler.runSync(fakeWhoopConnector, http, tokenStore, trigger);
  if (run.status !== "ok") {
    throw new Error(`connectorWorker: sync did not succeed — status=${run.status} error=${JSON.stringify(run.error)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
