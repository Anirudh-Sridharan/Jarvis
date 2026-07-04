/**
 * dashboardWorker.ts — two-writer cross-process smoke test fixture (TEST-02).
 *
 * Spawned as an independent OS process. Mirrors apps/dashboard/app/lib/services.ts's
 * dependency injection exactly: a no-op embedder (the BFF is deliberately
 * network-free) and an LlmClient stub whose complete() throws. profile.correctFact
 * is deterministic and never calls the LLM, so the throwing stub is safe here.
 *
 * Reads JARVIS_DATA_DIR + FACT_ID from env, corrects the seeded fact, and exits
 * 0 on success / 1 on failure (stderr carries the error for the parent to assert
 * against, e.g. no SQLITE_BUSY / "database is locked").
 *
 * Imports ONLY the memory leaf package's public API (never the core daemon
 * package) — the dependency-direction invariant holds even though this
 * fixture lives under services/core/test.
 */
import { createMemorySystem } from "@jarvis/memory";
import type { Embedder, LlmClient } from "@jarvis/memory";

// Mirrors apps/dashboard/app/lib/services.ts's noOpEmbedder.
const noOpEmbedder: Embedder = {
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  },
};

// Mirrors apps/dashboard/app/lib/services.ts's noOpLlm / noOpMemoryLlm.
const throwingLlm: LlmClient = {
  async complete(): Promise<string> {
    throw new Error("LLM not available in dashboard BFF");
  },
};

async function main(): Promise<void> {
  const dataDir = process.env.JARVIS_DATA_DIR;
  const factId = process.env.FACT_ID;
  if (!dataDir) throw new Error("dashboardWorker: JARVIS_DATA_DIR env var is required");
  if (!factId) throw new Error("dashboardWorker: FACT_ID env var is required");

  const mem = createMemorySystem({ embedder: noOpEmbedder, llm: throwingLlm, dataDir });
  await mem.profile.correctFact({ factId, correction: "light roast" });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
