/**
 * sync-race-cross-process.test.ts
 *
 * 11-02 Task 2 — proves the scheduled-vs-manual connector-sync race is safe
 * across REAL OS processes (mirrors two-writer-cross-process.test.ts's
 * two-real-subprocess shape, adapted to a connector sync race instead of a
 * memory-correction race).
 *
 * Production topology: the dashboard-spawned "Sync now" CLI (`npm run
 * connect -- sync whoop`) and core's in-process sync-connectors scheduled
 * job are two independent OS processes that can both call
 * Scheduler.runSync() for the SAME connector against the SAME on-disk
 * integrations.db. WAL mode + a {timeout:5000} busy timeout (see the
 * integrations package's db/database.ts) are the storage-layer guarantees
 * under test — no new locking is added by this phase.
 *
 * This test spawns two REAL child processes against one shared temp data
 * dir — one with SYNC_TRIGGER=manual (mirrors the CLI path), one with
 * SYNC_TRIGGER=schedule (mirrors the in-process scheduled job) — and
 * asserts both exit 0, neither logs a lock failure, PRAGMA integrity_check
 * is "ok", and scheduler.listRuns("whoop") holds both runs with a sane
 * (non-null, non-garbled, converged) cursor.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createIntegrations } from "@jarvis/integrations";
import { FakeHttp, MemoryTokenStore } from "@jarvis/integrations/testing";

const here = dirname(fileURLToPath(import.meta.url));
const CONNECTOR_WORKER = join(here, "fixtures", "syncRace", "connectorWorker.ts");

interface WorkerOutcome {
  code: number | null;
  stderr: string;
}

function runWorker(scriptPath: string, env: NodeJS.ProcessEnv): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      env,
      cwd: here,
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("sync-race cross-process smoke test (scheduled vs. manual connector sync)", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "jarvis-sync-race-"));
    // Warm up integrations.db (open + apply schema) from the parent process
    // BEFORE spawning the two racing workers — mirrors two-writer-cross-
    // process.test.ts's beforeAll seeding. Without this, both child
    // processes race to CREATE TABLE the schema from scratch on a brand-new
    // file, which is a much harsher (and not representative-of-production)
    // race than the one this test targets: production always has an
    // already-initialized integrations.db by the time either a scheduled or
    // manual sync runs.
    createIntegrations({
      http: new FakeHttp(),
      clock: { now: () => Date.now() },
      tokenStore: new MemoryTokenStore(),
      llm: { complete: async () => "" },
      dataDir,
    });
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "a scheduled sync racing a manual sync of the same connector completes with no SQLITE_BUSY, integrity ok, and two sync_runs rows",
    async () => {
      const sharedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        JARVIS_DATA_DIR: dataDir,
        NODE_NO_WARNINGS: "1",
      };

      const [manualResult, scheduleResult] = await Promise.all([
        runWorker(CONNECTOR_WORKER, { ...sharedEnv, SYNC_TRIGGER: "manual" }),
        runWorker(CONNECTOR_WORKER, { ...sharedEnv, SYNC_TRIGGER: "schedule" }),
      ]);

      // Both children must exit cleanly.
      expect(manualResult.code, `manual worker stderr: ${manualResult.stderr}`).toBe(0);
      expect(scheduleResult.code, `schedule worker stderr: ${scheduleResult.stderr}`).toBe(0);

      // Neither child should have hit a lock failure.
      expect(manualResult.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);
      expect(scheduleResult.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);

      // The DB must still be structurally sound after concurrent writes.
      const db = new DatabaseSync(join(dataDir, "integrations.db"));
      const integrityRows = db.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[];
      expect(integrityRows).toEqual([{ integrity_check: "ok" }]);
      db.close();

      // Re-open through the public API (mirrors how a real consumer would
      // read post-race state) and assert on scheduler.listRuns — both runs
      // landed, one per trigger, neither corrupted the other.
      const verify = createIntegrations({
        http: new FakeHttp(),
        clock: { now: () => Date.now() },
        tokenStore: new MemoryTokenStore(),
        llm: { complete: async () => "" },
        dataDir,
      });
      const runs = verify.scheduler.listRuns("whoop");
      expect(runs).toHaveLength(2);
      expect(runs.every((r) => r.status === "ok")).toBe(true);
      expect(new Set(runs.map((r) => r.trigger))).toEqual(new Set(["manual", "schedule"]));

      // The fake connector's sync() always returns the same fixed nextCursor
      // regardless of which process wrote last — the idempotent
      // ON CONFLICT(source, stream) DO UPDATE cursor upsert converges on it,
      // proving the concurrent write didn't garble or null it out.
      expect(runs.every((r) => r.cursorAfter === "2026-07-09T12:00:00.000Z")).toBe(true);
    },
    { timeout: 30_000 },
  );
});
