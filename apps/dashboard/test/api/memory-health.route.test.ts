import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MEM-03: behavioral coverage of the dashboard BFF's /api/memory/health route
 * (apps/dashboard/app/api/memory/health/route.ts). Mirrors
 * apps/dashboard/test/api/profile.route.test.ts's freshHandlers()/
 * mkdtempSync/vi.resetModules() isolation.
 *
 * Forced-failure visibility (SC3) is proven by running consolidation through
 * a SEPARATE MemorySystem instance pointed at the SAME JARVIS_DATA_DIR — the
 * dashboard's own getMemory() singleton wires a no-op LLM stub (it never runs
 * consolidation itself; app/lib/services.ts's own doc comment documents it as
 * a reader plus a narrow profile-write path). This mirrors the actual
 * production shape: core writes, the dashboard BFF reads, same SQLite file,
 * two processes.
 */

/** LLM that ALWAYS fails extraction for records containing a "FAILME" marker
 *  (verbatim recipe from services/memory/test/consolidation.test.ts's MEM-02
 *  suite, reused here through the public @jarvis/memory/testing surface). */
async function makeAlwaysFailingLlm() {
  const { FakeLlm } = await import("@jarvis/memory/testing");
  class AlwaysFailingLlm extends FakeLlm {
    override async complete(opts: {
      system?: string;
      prompt: string;
      json?: boolean;
    }): Promise<string> {
      if (
        opts.prompt.includes("discrete, updateable FACTS") &&
        opts.prompt.includes("FAILME")
      ) {
        throw new Error("simulated permanent LLM extraction failure");
      }
      return super.complete(opts);
    }
  }
  return new AlwaysFailingLlm();
}

async function freshHandlers() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-dashboard-test-"));
  process.env.JARVIS_DATA_DIR = dir;
  vi.resetModules();
  const services = await import("../../app/lib/services");
  const route = await import("../../app/api/memory/health/route");
  return { dir, services, route };
}

beforeEach(() => {
  delete process.env.JARVIS_DATA_DIR;
});

describe("memory/health route — empty DB", () => {
  it("GET on a fresh temp dir returns 200 state: ok with all-zero counts + lastRun null", async () => {
    const { route } = await freshHandlers();
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ok");
    expect(body.data).toEqual({
      pendingCount: 0,
      consolidatedCount: 0,
      deadLetterCount: 0,
      lastRun: null,
    });
  });
});

describe("memory/health route — seeded forced-failure (SC2 + SC3)", () => {
  it("matches store.getConsolidationHealth() and surfaces a forced dead-letter (deadLetterCount > 0, lastRun.errors non-empty)", async () => {
    const { dir, services, route } = await freshHandlers();

    const { createMemorySystem } = await import("@jarvis/memory");
    const { FakeEmbedder, FixedClock } = await import("@jarvis/memory/testing");
    const llm = await makeAlwaysFailingLlm();

    // Separate MemorySystem instance, same dataDir — mirrors core writing and
    // the dashboard BFF reading the same SQLite file as two processes.
    const clock = new FixedClock(1_700_000_000_000);
    const seeder = createMemorySystem({
      embedder: new FakeEmbedder(),
      llm,
      dataDir: dir,
      clock,
    });
    await seeder.capture.captureNote({ text: "FAILME dashboard dead letter", noteId: "dash-dead-1" });
    for (let i = 0; i < 5; i++) {
      await seeder.consolidation.run("manual");
      clock.advance(7 * 60 * 60_000);
    }

    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ok");

    const mem = services.getMemory();
    const expected = mem.store.getConsolidationHealth();
    expect(body.data).toEqual(expected);
    expect(body.data.deadLetterCount).toBeGreaterThan(0);
    expect(body.data.lastRun).not.toBeNull();
    expect(body.data.lastRun.errors.length).toBeGreaterThan(0);
  });
});
