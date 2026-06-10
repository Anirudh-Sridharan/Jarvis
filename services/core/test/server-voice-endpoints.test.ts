/**
 * Server-level tests for the /voice/* endpoints backing the dashboard HUD.
 * A fake-built VoiceSessionManager is injected via setVoiceSessionManager()
 * so no sidecar, mic, or speaker is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm as FakeMemoryLlm } from "@jarvis/memory/testing";
import { createVoiceOrchestrator } from "@jarvis/voice";
import { FakeSttEngine, FakeTtsEngine, FakeCoreClient } from "@jarvis/voice/testing";

import { setMemorySystem, resetMemorySystem } from "../src/memory/memorySystem.js";
import {
  VoiceSessionManager,
  setVoiceSessionManager,
  getVoiceSessionManager,
  resetVoiceSessionManager,
} from "../src/voice/voiceSessionManager.js";

let app: import("hono").Hono;
let tmpDir: string;

function fakeSidecarFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/health")) return Response.json({ state: "ready" });
    return Response.json({ ok: true });
  }) as typeof fetch;
}

function makeFakeManager(): VoiceSessionManager {
  return new VoiceSessionManager({
    sidecarUrl: "http://sidecar.test",
    fetchImpl: fakeSidecarFetch(),
    orchestratorFactory: (wakeSource) =>
      createVoiceOrchestrator({
        wakeWord: wakeSource,
        stt: new FakeSttEngine(),
        tts: new FakeTtsEngine(),
        core: new FakeCoreClient(),
      }),
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "jarvis-server-voice-"));
  // Seed the memory singleton BEFORE importing server.ts (same pattern as
  // server-agent-cors.test.ts) so the server doesn't build a real one.
  setMemorySystem(
    createMemorySystem({
      embedder: new FakeEmbedder(),
      llm: new FakeMemoryLlm(),
      dataDir: tmpDir,
    }),
  );
  setVoiceSessionManager(makeFakeManager());
  const server = await import("../src/server.js");
  app = server.app;
});

afterAll(async () => {
  await getVoiceSessionManager()?.stop();
  resetVoiceSessionManager();
  resetMemorySystem();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /voice/status", () => {
  it("reports inactive before start", async () => {
    const res = await app.fetch(new Request("http://localhost/voice/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: { active: boolean; state: string } };
    expect(body.ok).toBe(true);
    expect(body.status.active).toBe(false);
    expect(body.status.state).toBe("inactive");
  });
});

describe("POST /voice/wake before start", () => {
  it("is acknowledged but not accepted", async () => {
    const res = await app.fetch(
      new Request("http://localhost/voice/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "wake", confidence: 0.9, ts: 123, device_id: "mic0" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; accepted: boolean };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(false);
  });
});

describe("voice session lifecycle over HTTP", () => {
  it("start → status active → wake accepted (sidecar payload mapped) → stop", async () => {
    const start = await app.fetch(
      new Request("http://localhost/voice/start", { method: "POST" }),
    );
    expect(start.status).toBe(200);
    const started = (await start.json()) as { ok: boolean; status: { active: boolean } };
    expect(started.ok).toBe(true);
    expect(started.status.active).toBe(true);

    // Idempotent re-start
    const again = await app.fetch(
      new Request("http://localhost/voice/start", { method: "POST" }),
    );
    expect(again.status).toBe(200);

    // Sidecar-shaped wake payload (ts/device_id snake_case) is accepted.
    const wake = await app.fetch(
      new Request("http://localhost/voice/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "wake", confidence: 0.87, ts: 1718000000123, device_id: "mic0" }),
      }),
    );
    const wakeBody = (await wake.json()) as { ok: boolean; accepted: boolean };
    expect(wakeBody.accepted).toBe(true);

    const stop = await app.fetch(
      new Request("http://localhost/voice/stop", { method: "POST" }),
    );
    expect(stop.status).toBe(200);
    const stopped = (await stop.json()) as { ok: boolean; status: { active: boolean } };
    expect(stopped.status.active).toBe(false);
  });

  it("rejects a malformed wake payload", async () => {
    const res = await app.fetch(
      new Request("http://localhost/voice/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confidence: "high" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /voice/events", () => {
  it("streams a voice_status frame first", async () => {
    const res = await app.fetch(new Request("http://localhost/voice/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"voice_status"');
    await reader.cancel();
  });
});
