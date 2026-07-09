/**
 * server-telemetry-memory.test.ts
 *
 * MEM-03: GET /telemetry gains a `memory` key computed from
 * memory.store.getConsolidationHealth() — the same aggregate the dashboard's
 * /api/memory/health BFF route reads from the same SQLite file (Task 3).
 *
 * Mirrors server-voice-endpoints.test.ts's pre-seed-singleton-before-import
 * idiom (server.ts memoizes getMemorySystem(gateway) at module load).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm as FakeMemoryLlm, FixedClock } from "@jarvis/memory/testing";

// NOTE: memorySystem.js is imported dynamically (not statically) in each
// describe block below, AFTER vi.resetModules(). A static top-level import
// here would bind to the module instance loaded before any reset, which goes
// stale once a later dynamic import("../src/server.js") re-evaluates the
// whole module graph fresh — the second describe block needs its own fresh
// memorySystem.js singleton state (initialized=false) to observe
// setMemorySystem(null) rather than falling through to a real construction
// attempt against the live JARVIS_DATA_DIR.

/** LLM that ALWAYS fails extraction for records containing a "FAILME" marker
 *  (verbatim from services/memory/test/consolidation.test.ts's MEM-02 suite,
 *  reused here to seed a hermetic forced-failure dead-letter through the HTTP
 *  surface — see 12-RESEARCH.md Pitfall 4). */
class AlwaysFailingLlm extends FakeMemoryLlm {
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

describe("GET /telemetry — memory key (singleton available)", () => {
  let app: import("hono").Hono;
  let tmpDir: string;
  let memory: ReturnType<typeof createMemorySystem>;
  let clock: FixedClock;
  let memorySystemModule: typeof import("../src/memory/memorySystem.js");

  beforeAll(async () => {
    vi.resetModules();
    tmpDir = mkdtempSync(join(tmpdir(), "jarvis-server-telemetry-memory-"));
    clock = new FixedClock(1_700_000_000_000);
    memory = createMemorySystem({
      embedder: new FakeEmbedder(),
      llm: new AlwaysFailingLlm(),
      dataDir: tmpDir,
      clock,
    });
    memorySystemModule = await import("../src/memory/memorySystem.js");
    memorySystemModule.setMemorySystem(memory);
    const server = await import("../src/server.js");
    app = server.app;
  });

  afterAll(() => {
    memorySystemModule.resetMemorySystem();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reflects a seeded dead-letter in the /telemetry memory key (forced-failure visibility at the HTTP surface)", async () => {
    // Force a dead-letter through the same store the server reads. DEAD_LETTER_THRESHOLD
    // (=5, services/memory/src/consolidation/retryPolicy.ts — not re-exported from the
    // public package surface, so mirrored as a literal here) failed passes, clock
    // advanced past the 6h max backoff cap between each (same recipe as
    // services/memory/test/consolidation.test.ts / consolidationHealth.test.ts).
    const { record } = await memory.capture.captureNote({
      text: "FAILME telemetry dead letter",
      noteId: "telemetry-dead-1",
    });
    for (let i = 0; i < 5; i++) {
      await memory.consolidation.run("manual");
      clock.advance(7 * 60 * 60_000);
    }
    // Sanity: the mechanism actually fired before asserting the HTTP surface.
    const dead = memory.store.getDeadLetterRecords();
    expect(dead.find((r) => r.id === record.id)).toBeDefined();

    const res = await app.fetch(new Request("http://localhost/telemetry"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      memory: {
        pendingCount: number;
        consolidatedCount: number;
        deadLetterCount: number;
        lastRun: { errors: { stage: number; message: string }[] } | null;
      } | null;
    };
    expect(body.ok).toBe(true);

    const expected = memory.store.getConsolidationHealth();
    expect(body.memory).toEqual(expected);
    expect(body.memory!.deadLetterCount).toBeGreaterThan(0);
    expect(body.memory!.lastRun).not.toBeNull();
    expect(body.memory!.lastRun!.errors.length).toBeGreaterThan(0);
  });

  it("existing summary/recent keys are unchanged (additive, backward-compatible)", async () => {
    const res = await app.fetch(new Request("http://localhost/telemetry"));
    const body = (await res.json()) as { summary: unknown; recent: unknown };
    expect(body.summary).toBeDefined();
    expect(body.recent).toBeDefined();
  });
});

describe("GET /telemetry — memory key (singleton unavailable)", () => {
  let app: import("hono").Hono;
  let memorySystemModule: typeof import("../src/memory/memorySystem.js");

  beforeAll(async () => {
    // Degrade path: memory singleton unavailable. server.ts memoizes
    // getMemorySystem(gateway) at module-evaluation time and dynamic import()
    // caches the module by specifier within a test file — reset the module
    // registry so this describe block gets a fresh evaluation, then set the
    // null singleton on THAT fresh memorySystem.js instance before importing
    // server.js (which imports the same fresh instance).
    vi.resetModules();
    memorySystemModule = await import("../src/memory/memorySystem.js");
    memorySystemModule.setMemorySystem(null);
    const server = await import("../src/server.js");
    app = server.app;
  });

  afterAll(() => {
    memorySystemModule.resetMemorySystem();
  });

  it("degrades to memory: null with a 200 and ok: true (best-effort read, never a 503)", async () => {
    const res = await app.fetch(new Request("http://localhost/telemetry"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; memory: unknown };
    expect(body.ok).toBe(true);
    expect(body.memory).toBeNull();
  });
});
