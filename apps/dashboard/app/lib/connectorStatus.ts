/**
 * Server-only connector status assembly — feature 9 surface for feature 14.
 *
 * Token state is read from the macOS Keychain (com.jarvis.connector.<source>,
 * account "oauth" — same scheme as core's KeychainTokenStore) via the
 * `security` CLI. Read-only: the dashboard never writes or deletes entries,
 * and token payloads never leave this module — only derived state strings do.
 *
 * Sync history comes from the integrations DB (sync_runs via Scheduler.listRuns).
 * Push (apple_health) and finance (simplefin) sources have no sync runs, so
 * their freshness is derived from latest data timestamps instead.
 */

import "server-only";

import { execFile } from "node:child_process";
import type { SyncRun } from "@jarvis/integrations";
import type {
  ConnectorStatusContract,
  ConnectorTokenState,
  SyncRunContract,
} from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";

const SERVICE_PREFIX = "com.jarvis.connector.";
const ACCOUNT = "oauth";

interface CatalogEntry {
  id: string;
  label: string;
  desc: string;
  auth: ConnectorStatusContract["auth"];
  scheduleLabel: string;
  syncable: boolean;
  connectCmd?: string;
}

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: "whoop",
    label: "WHOOP",
    desc: "Sleep, recovery, HRV, strain.",
    auth: "oauth",
    scheduleLabel: "daily · 07:00 UTC",
    syncable: true,
    connectCmd: "npm run connect -- whoop",
  },
  {
    id: "apple_health",
    label: "Apple Health",
    desc: "Steps, heart rate, weight, SpO2 — push-based.",
    auth: "push",
    scheduleLabel: "push (Shortcuts/export)",
    syncable: false,
  },
  {
    id: "gcal",
    label: "Google Calendar",
    desc: "Events and agenda.",
    auth: "oauth",
    scheduleLabel: "hourly",
    syncable: true,
    connectCmd: "npm run connect -- gcal",
  },
  {
    id: "github",
    label: "GitHub",
    desc: "Commits, PRs, code activity.",
    auth: "pat",
    scheduleLabel: "every 30 min",
    syncable: true,
    connectCmd: "store a PAT in Keychain: com.jarvis.connector.github",
  },
  {
    id: "gmail",
    label: "Gmail",
    desc: "Email volume, unread count, summaries.",
    auth: "oauth",
    scheduleLabel: "every 30 min",
    syncable: true,
    connectCmd: "npm run connect -- gmail",
  },
  {
    id: "simplefin",
    label: "SimpleFIN",
    desc: "Accounts, balances, transactions.",
    auth: "token",
    scheduleLabel: "manual",
    syncable: true,
    connectCmd: "set SIMPLEFIN_ACCESS_URL in .env, then sync",
  },
  {
    id: "files",
    label: "Documents",
    desc: "Local PDFs, text & markdown — extracted, chunked, and captured into memory.",
    auth: "local",
    scheduleLabel: "manual",
    syncable: true,
    connectCmd: "set JARVIS_FILES_DIR in .env (or: npm run connect -- sync files <path>)",
  },
];

function runSecurity(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("security", args, { encoding: "utf8", timeout: 5_000 }, (err, stdout) => {
      const exitCode = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      resolve({ exitCode: typeof exitCode === "number" ? exitCode : 1, stdout: stdout ?? "" });
    });
  });
}

async function keychainTokenState(
  source: string,
): Promise<{ token: ConnectorTokenState; expiresInMin?: number }> {
  if (process.platform !== "darwin") return { token: "not_connected" };

  const res = await runSecurity([
    "find-generic-password",
    "-s",
    `${SERVICE_PREFIX}${source}`,
    "-a",
    ACCOUNT,
    "-w",
  ]);
  if (res.exitCode !== 0) return { token: "not_connected" };

  try {
    const tokens = JSON.parse(res.stdout.trim()) as {
      expiresAt?: number;
      refreshToken?: string;
    };
    if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
      return { token: tokens.refreshToken ? "expired_refreshable" : "expired_reconsent" };
    }
    return {
      token: "connected",
      expiresInMin: tokens.expiresAt
        ? Math.round((tokens.expiresAt - Date.now()) / 60_000)
        : undefined,
    };
  } catch {
    // Entry exists but isn't our JSON payload (e.g. a bare PAT) — still connected.
    return { token: "connected" };
  }
}

function toRunContract(run: SyncRun): SyncRunContract {
  return {
    id: run.id,
    source: run.source,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    pointsWritten: run.pointsWritten,
    error: run.error?.message,
  };
}

/** Latest data timestamp across a source's representative metrics. */
function latestDataTs(metricIds: string[], source: string): string | undefined {
  const { metrics } = getIntegrations();
  let max: string | undefined;
  for (const id of metricIds) {
    const point = metrics.latest(id, source);
    if (point && (!max || point.ts > max)) max = point.ts;
  }
  return max;
}

const APPLE_METRICS = ["steps", "hrv", "restingHr", "heartRate", "sleep.duration_min", "weight"];

export async function getConnectorStatuses(): Promise<ConnectorStatusContract[]> {
  const { scheduler, finance } = getIntegrations();

  return Promise.all(
    CONNECTOR_CATALOG.map(async (entry): Promise<ConnectorStatusContract> => {
      const runs = scheduler
        .listRuns(entry.id as SyncRun["source"], 5)
        .map(toRunContract);
      const lastSync = runs[0] ?? null;

      let token: ConnectorTokenState = "n/a";
      let tokenExpiresInMin: number | undefined;
      let lastDataAt: string | undefined;

      if (entry.auth === "oauth" || entry.auth === "pat") {
        const state = await keychainTokenState(entry.id);
        token = state.token;
        tokenExpiresInMin = state.expiresInMin;
      } else if (entry.id === "apple_health") {
        lastDataAt = latestDataTs(APPLE_METRICS, "apple_health");
        token = lastDataAt ? "connected" : "not_connected";
      } else if (entry.id === "simplefin") {
        const accounts = finance.store.listAccounts();
        const lastSynced = accounts.map((a) => a.lastSyncedAt).sort().at(-1);
        lastDataAt = lastSynced;
        token = accounts.length > 0 ? "connected" : "not_connected";
      } else if (entry.id === "files") {
        // Filesystem source — "connected" once a default scan path is configured.
        token = process.env["JARVIS_FILES_DIR"] ? "connected" : "not_connected";
      }

      return {
        id: entry.id,
        label: entry.label,
        desc: entry.desc,
        auth: entry.auth,
        scheduleLabel: entry.scheduleLabel,
        token,
        tokenExpiresInMin,
        syncable: entry.syncable,
        connectCmd: entry.connectCmd,
        lastSync,
        recentRuns: runs,
        lastDataAt,
      };
    }),
  );
}
