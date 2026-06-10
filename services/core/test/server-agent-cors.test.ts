/**
 * server-agent-cors.test.ts
 *
 * Two server-level regressions:
 *
 * 1. Agent endpoints must come ALIVE when setAgentSystem() is called after
 *    server.ts has been imported. Previously the module-load call
 *    getAgentSystem(gateway, null) latched the singleton to null AND server.ts
 *    snapshotted the bag at import — /agent, /approvals/*, /audit were 503
 *    forever, even after the daemon wired real integrations.
 *
 * 2. CORS: the dashboard (http://localhost:3000) calls core from the browser;
 *    without the cors() middleware every browser fetch fails preflight.
 *    Loopback origins must be reflected; arbitrary origins must NOT be.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm as FakeMemoryLlm } from "@jarvis/memory/testing";
import { createAgentSystem } from "@jarvis/agent";
import { FakeLlm, FixedClock } from "@jarvis/agent/testing";

import { setMemorySystem, resetMemorySystem } from "../src/memory/memorySystem.js";
import {
  ApprovalQueue,
  setAgentSystem,
  resetAgentSystem,
} from "../src/agent/agentSystem.js";

let app: import("hono").Hono;
let tmpDirs: string[] = [];

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "jarvis-server-agent-cors-"));
  tmpDirs.push(d);
  return d;
}

beforeAll(async () => {
  // Seed the memory singleton BEFORE importing server.ts so the server doesn't
  // try to build a real one (same pattern as server-memory-wiring.test.ts).
  const memory = createMemorySystem({
    embedder: new FakeEmbedder(),
    llm: new FakeMemoryLlm(),
    dataDir: makeTempDir(),
  });
  setMemorySystem(memory);
  // VITEST guard prevents the server from listening.
  const server = await import("../src/server.js");
  app = server.app;
});

afterAll(() => {
  resetAgentSystem();
  resetMemorySystem();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe("server: agent endpoints resolve the bag per request", () => {
  it("503 before wiring; /approvals goes live after setAgentSystem()", async () => {
    resetAgentSystem();

    // Before any agent system is wired: 503 (and must NOT latch anything).
    const before = await app.fetch(new Request("http://localhost/approvals"));
    expect(before.status).toBe(503);

    // Wire an agent system AFTER server import — endpoints must pick it up.
    const queue = new ApprovalQueue();
    const agentSystem = createAgentSystem({
      llm: new FakeLlm(),
      tools: new Map(),
      clock: new FixedClock(Date.now()),
      dataDir: makeTempDir(),
      approvalSink: queue.sink,
    });
    setAgentSystem(agentSystem, queue);

    const after = await app.fetch(new Request("http://localhost/approvals"));
    expect(after.status).toBe(200);
    const body = (await after.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(Array.isArray(body["pending"])).toBe(true);

    // /audit also comes alive (same per-request resolution).
    const audit = await app.fetch(new Request("http://localhost/audit"));
    expect(audit.status).toBe(200);
  });
});

describe("server: CORS for the local dashboard", () => {
  it("reflects http://localhost:3000 in Access-Control-Allow-Origin", async () => {
    const res = await app.fetch(
      new Request("http://localhost/healthz", {
        headers: { Origin: "http://localhost:3000" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
  });

  it("answers preflight for POST /chat from the dashboard origin", async () => {
    const res = await app.fetch(
      new Request("http://localhost/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "http://127.0.0.1:3000",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("does NOT reflect non-loopback origins", async () => {
    const res = await app.fetch(
      new Request("http://localhost/healthz", {
        headers: { Origin: "https://evil.example.com" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeFalsy();
  });
});
