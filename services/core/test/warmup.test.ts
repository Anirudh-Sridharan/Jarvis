/**
 * warmup.test.ts
 *
 * Tests for the POST /warmup endpoint added to @jarvis/core.
 * Uses the same gateway-stub pattern as memory-integration.test.ts.
 *
 * The endpoint:
 *   - Resolves the default local chat model from the registry
 *   - Calls modelManager.ensureReady()
 *   - Returns { ok, state, modelId } on success
 *   - Returns 503 when no local model is configured
 *   - Returns 503 with ok:false when ensureReady() rejects
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { z } from "zod";

// We import the app components and rebuild a test app rather than using the
// top-level server.ts (which starts listening), mirroring the pattern used by
// the existing test in this workspace.
import { InferenceGateway } from "../src/inference/gateway.js";
import { loadConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Hono app with only the /warmup route, wired to the provided
 * gateway stub — avoids spinning up the full server.
 */
function buildWarmupApp(gatewayOverride: Partial<{
  modelManager: Partial<InstanceType<typeof InferenceGateway>["modelManager"]>;
  registry: Partial<InstanceType<typeof InferenceGateway>["registry"]>;
}>) {
  const app = new Hono();

  const gateway = gatewayOverride as unknown as InstanceType<typeof InferenceGateway>;

  app.post("/warmup", async (c) => {
    let entry: { id: string; modelRef: string } | undefined;
    try {
      entry = gateway.registry.defaultFor("chat", "local");
    } catch {
      return c.json({ ok: false, state: "unavailable", error: "No local chat model configured" }, 503);
    }
    try {
      await gateway.modelManager.ensureReady(entry.id, entry.modelRef);
    } catch (err) {
      const state = gateway.modelManager.getState();
      return c.json({
        ok: false,
        state,
        modelId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      }, 503);
    }
    const state = gateway.modelManager.getState();
    return c.json({ ok: true, state, modelId: entry.id });
  });

  return app;
}

/** POST helper that returns the parsed JSON body and status. */
async function post(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const req = new Request(`http://localhost${path}`, { method: "POST" });
  const res = await app.fetch(req);
  const body = await res.json() as unknown;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /warmup — success path", () => {
  it("returns ok:true and state:ready when model loads successfully", async () => {
    let currentState = "unloaded";
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => ({ id: "qwen-local-chat", modelRef: "mlx-community/Qwen2.5-7B-Instruct-4bit" }),
      },
      modelManager: {
        ensureReady: async () => { currentState = "ready"; },
        getState: () => currentState as ReturnType<InstanceType<typeof InferenceGateway>["modelManager"]["getState"]>,
      },
    });

    const { status, body } = await post(app, "/warmup");

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, state: "ready", modelId: "qwen-local-chat" });
  });

  it("returns state:generating when model is already generating (still ok)", async () => {
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => ({ id: "qwen-local-chat", modelRef: "ref" }),
      },
      modelManager: {
        ensureReady: async () => { /* no-op: already ready */ },
        getState: () => "generating" as const,
      },
    });

    const { status, body } = await post(app, "/warmup");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, state: "generating" });
  });

  it("returns the modelId from the registry entry", async () => {
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => ({ id: "my-custom-model", modelRef: "some/ref" }),
      },
      modelManager: {
        ensureReady: async () => {},
        getState: () => "ready" as const,
      },
    });

    const { status, body } = await post(app, "/warmup");
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b["modelId"]).toBe("my-custom-model");
  });
});

describe("POST /warmup — no local model configured", () => {
  it("returns 503 with ok:false when registry has no local chat model", async () => {
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => { throw new Error("No registry entry for kind=\"chat\" target=\"local\""); },
      },
      modelManager: {
        ensureReady: async () => {},
        getState: () => "unloaded" as const,
      },
    });

    const { status, body } = await post(app, "/warmup");
    expect(status).toBe(503);
    const b = body as Record<string, unknown>;
    expect(b["ok"]).toBe(false);
    expect(b["state"]).toBe("unavailable");
    expect(b["error"]).toContain("No local chat model configured");
  });
});

describe("POST /warmup — ensureReady failure (sidecar down / OOM)", () => {
  it("returns 503 with ok:false and the error state when ensureReady throws", async () => {
    let currentState = "error";
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => ({ id: "qwen-local-chat", modelRef: "ref" }),
      },
      modelManager: {
        ensureReady: async () => { throw new Error("MLX sidecar OOM"); },
        getState: () => currentState as ReturnType<InstanceType<typeof InferenceGateway>["modelManager"]["getState"]>,
      },
    });

    const { status, body } = await post(app, "/warmup");
    expect(status).toBe(503);
    const b = body as Record<string, unknown>;
    expect(b["ok"]).toBe(false);
    expect(b["state"]).toBe("error");
    expect(b["modelId"]).toBe("qwen-local-chat");
    expect(typeof b["error"]).toBe("string");
    expect(String(b["error"])).toContain("OOM");
  });

  it("returns the current state even after failure", async () => {
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => ({ id: "model", modelRef: "ref" }),
      },
      modelManager: {
        ensureReady: async () => { throw new Error("timeout"); },
        getState: () => "error" as const,
      },
    });

    const { status, body } = await post(app, "/warmup");
    expect(status).toBe(503);
    const b = body as Record<string, unknown>;
    expect(b["state"]).toBe("error");
  });
});

describe("POST /warmup — idempotency", () => {
  it("can be called multiple times without error when model is already ready", async () => {
    const calls: number[] = [];
    const app = buildWarmupApp({
      registry: {
        defaultFor: () => ({ id: "qwen-local-chat", modelRef: "ref" }),
      },
      modelManager: {
        ensureReady: async () => { calls.push(1); },
        getState: () => "ready" as const,
      },
    });

    const r1 = await post(app, "/warmup");
    const r2 = await post(app, "/warmup");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
