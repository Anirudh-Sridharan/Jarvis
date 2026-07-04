/**
 * two-writer-cross-process.test.ts
 *
 * TEST-02: proves the two-process SQLite writer boundary is safe.
 *
 * Production topology: the dashboard BFF (apps/dashboard/app/lib/services.ts)
 * and core's background ConsolidationScheduler (services/core/src/memory/
 * consolidationScheduler.ts) are two independent OS processes that both write
 * the same on-disk JARVIS_DATA_DIR via @jarvis/memory's createMemorySystem.
 * WAL mode (already enabled) allows concurrent readers, but writer/writer
 * contention needs a non-zero busy timeout to avoid SQLITE_BUSY — see
 * services/memory/src/db/database.ts and services/integrations/src/db/database.ts.
 *
 * This test spawns two REAL child processes (not just two in-process
 * DatabaseSync handles) against one shared temp data dir:
 *   - dashboardWorker.ts — mirrors the dashboard BFF's DI, corrects a fact
 *   - coreWorker.ts      — mirrors ConsolidationScheduler's DI, runs consolidation
 * and asserts both exit 0, neither logs a lock failure, PRAGMA integrity_check
 * is "ok", and both writes actually landed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemorySystem } from "@jarvis/memory";
import type { MemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_WORKER = join(here, "fixtures", "twoWriter", "dashboardWorker.ts");
const CORE_WORKER = join(here, "fixtures", "twoWriter", "coreWorker.ts");

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

describe("two-writer cross-process smoke test (TEST-02)", () => {
  let dataDir: string;
  let seedMem: MemorySystem;
  let factId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "jarvis-two-writer-"));
    seedMem = createMemorySystem({
      embedder: new FakeEmbedder(),
      llm: new FakeLlm(),
      dataDir,
    });

    // Seed a "self" entity + a "prefers" fact for the dashboard-like worker to correct.
    const entity = await seedMem.store.upsertEntity({
      name: "self",
      entityType: "other",
      text: "The user",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });
    const fact = await seedMem.store.upsertFact({
      subjectId: entity.id,
      predicate: "prefers",
      objectLiteral: "dark roast",
      text: "User prefers dark roast",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.9 },
    });
    factId = fact.id;

    // Seed a pending experience record for the core-like worker to promote.
    await seedMem.capture.captureConversationTurn({
      role: "user",
      content: "I prefer TypeScript over Python for type safety",
      conversationId: "conv-two-writer",
      messageId: "msg-two-writer-1",
    });
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(
    "two concurrent OS processes write the same data dir without corruption or lock failure",
    async () => {
      const sharedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        JARVIS_DATA_DIR: dataDir,
        NODE_NO_WARNINGS: "1",
      };

      const [dashboardResult, coreResult] = await Promise.all([
        runWorker(DASHBOARD_WORKER, { ...sharedEnv, FACT_ID: factId }),
        runWorker(CORE_WORKER, sharedEnv),
      ]);

      // Both children must exit cleanly.
      expect(dashboardResult.code, `dashboardWorker stderr: ${dashboardResult.stderr}`).toBe(0);
      expect(coreResult.code, `coreWorker stderr: ${coreResult.stderr}`).toBe(0);

      // Neither child should have hit a lock failure.
      expect(dashboardResult.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);
      expect(coreResult.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);

      // The DB must still be structurally sound after concurrent writes.
      const integrityRows = seedMem.store.rawDb
        .prepare("PRAGMA integrity_check")
        .all() as { integrity_check: string }[];
      expect(integrityRows).toEqual([{ integrity_check: "ok" }]);

      // The dashboard worker's correction landed: bi-temporal state, not
      // retrieval (the dashboard's no-op embedder means no vector match —
      // assert on deriveProfile()'s live-fact state per 03-RESEARCH.md Pitfall 5).
      const profile = await seedMem.profile.deriveProfile({ useLlm: false, cache: false });
      const preferenceValues = profile.preferences.map((p) => p.value);
      expect(preferenceValues).toContain("light roast");
      expect(preferenceValues).not.toContain("dark roast");

      const oldFact = seedMem.store.getFactById(factId);
      expect(oldFact?.invalidatedAt).toBeTruthy();

      // The core worker's consolidation promoted the pending record.
      const pending = seedMem.store.getPendingExperienceRecords();
      expect(pending).toHaveLength(0);
    },
    { timeout: 30_000 },
  );
});
