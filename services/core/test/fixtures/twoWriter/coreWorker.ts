/**
 * coreWorker.ts — two-writer cross-process smoke test fixture (TEST-02).
 *
 * Spawned as an independent OS process. Mirrors what
 * services/core/src/memory/consolidationScheduler.ts wraps in production: a
 * MemorySystem built with FakeEmbedder/FakeLlm (deterministic, no real model
 * server), running a manual consolidation pass against the shared data dir.
 *
 * Reads JARVIS_DATA_DIR from env, runs consolidation, and exits 0 on success /
 * 1 on failure (stderr carries the error for the parent to assert against,
 * e.g. no SQLITE_BUSY / "database is locked").
 *
 * Imports ONLY the memory leaf package's public API + its testing fakes
 * (never the core daemon package) — the dependency-direction invariant holds
 * even though this fixture lives under services/core/test.
 */
import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";

async function main(): Promise<void> {
  const dataDir = process.env.JARVIS_DATA_DIR;
  if (!dataDir) throw new Error("coreWorker: JARVIS_DATA_DIR env var is required");

  const mem = createMemorySystem({
    embedder: new FakeEmbedder(),
    llm: new FakeLlm(),
    dataDir,
  });
  await mem.consolidation.run("manual");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
