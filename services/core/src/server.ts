/**
 * Core HTTP server (features 1 + 2 + agent): Hono app wiring the inference
 * gateway, chat core, and agent system behind the cross-package contract.
 *
 * Endpoints:
 *   GET  /healthz  -> { ok: true }
 *   GET  /status   -> { ok: true, model: { id, state, target, ramHeadroomGB, fallbackActive } }
 *   POST /chat     -> SSE stream of { type: status|token|done|error } events
 *                     body: { message: string, conversationId?: string }
 *   POST /warmup   -> { ok, state, modelId }
 *
 *   Agent endpoints (degrade gracefully if subsystems unavailable):
 *   POST /agent    -> SSE stream of agent steps + approval-needed events
 *                     body: { goal: string }
 *   GET  /approvals                  -> pending approval requests
 *   POST /approvals/:id/approve      -> approve a pending request
 *   POST /approvals/:id/reject       -> reject a pending request
 *   GET  /audit                      -> recent audit entries + chain verify flag
 *
 * Listens on CORE_PORT (default 8080).
 */
import "./loadEnv.js"; // MUST be first: populates process.env from .env before config reads it
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { InferenceGateway } from "./inference/gateway.js";
import { ChatCore } from "./chat/chatCore.js";
import { getDataDir } from "./dataDir.js";
import { InMemoryConversationStore } from "./chat/conversationStore.js";
import { createSqliteConversationStore } from "./chat/sqliteConversationStore.js";
import { getAgentSystem } from "./agent/agentSystem.js";
import { bootstrapLiveAgent, getLiveCalendarMirror } from "./agent/liveBootstrap.js";
import { buildAgendaBlock } from "./chat/calendarAgenda.js";
import { getMemorySystem } from "./memory/memorySystem.js";
import { DatabaseSync } from "node:sqlite";
import { setTelemetrySink } from "./inference/telemetry.js";
import { TelemetrySink, createTelemetrySink } from "./inference/telemetrySink.js";
import { ConsolidationScheduler } from "./memory/consolidationScheduler.js";
import type { WakeEvent } from "@jarvis/voice";
import {
  getVoiceSessionManager,
  type VoiceEventFrame,
} from "./voice/voiceSessionManager.js";
import { createDefaultVoiceSessionManager } from "./voice/buildVoiceDeps.js";

const config = loadConfig();
const gateway = new InferenceGateway(config);
// Durable chat transcript (feature 2/4): conversations survive core restarts.
// Tests keep the in-memory store — they must not touch ~/.jarvis/data.
const store = process.env["VITEST"]
  ? new InMemoryConversationStore()
  : createSqliteConversationStore(getDataDir());
// Wire the persistent memory system (SQLite-backed) so chat turns are captured
// and prior memories retrieved. Without this, ChatCore.memory defaults to null
// and the assistant has no cross-session memory (it can't remember your name
// after a restart). Returns null and degrades gracefully if memory can't init.
const memory = getMemorySystem(gateway);
// Telemetry sink: routing + per-turn TTFT/tps persisted for GET /telemetry.
// In-memory DB under vitest so tests never touch ~/.jarvis/data.
const telemetrySink = process.env["VITEST"]
  ? new TelemetrySink(new DatabaseSync(":memory:"))
  : createTelemetrySink(getDataDir());
setTelemetrySink(telemetrySink);
// Connected-app agenda: calendar-shaped questions get a deterministic agenda
// block rendered from the live Google Calendar mirror (lazy; null under tests
// and when integrations are unavailable — chat degrades to memory-only).
const chatCore = new ChatCore(gateway, store, memory, {
  getAgendaBlock(now) {
    const mirror = getLiveCalendarMirror(gateway);
    return mirror ? buildAgendaBlock(mirror, now) : "";
  },
});
// Background consolidation: promotes captured turns into the retrievable graph
// so recall works without a manual step (retrieval only sees consolidated
// memories). Not started under tests (VITEST guard).
const consolidationScheduler = memory ? new ConsolidationScheduler(memory) : null;
if (consolidationScheduler && !process.env["VITEST"]) {
  consolidationScheduler.start();
}

const app = new Hono();

// The dashboard (http://localhost:3000) calls core from the browser — without
// CORS every fetch fails preflight. Loopback-only origins: this is a
// local-first single-user app, never reflect arbitrary origins.
app.use(
  "*",
  cors({
    origin: (origin) =>
      origin && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
        ? origin
        : "",
  }),
);

// ── Shared request helpers ────────────────────────────────────────────────────

/** Normalize a thrown value to a string message for error responses. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Set the three Server-Sent-Events response headers on a Hono context. */
function setSseHeaders(c: Context): void {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
}

/**
 * Parse a JSON request body, returning the parsed value or a sentinel so the
 * caller can answer 400 without nesting a try/catch on every route.
 */
const INVALID_JSON = Symbol("invalid-json");
async function readJsonBody(c: Context): Promise<unknown | typeof INVALID_JSON> {
  try {
    return await c.req.json();
  } catch {
    return INVALID_JSON;
  }
}

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/telemetry", (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const sinceHours = Number(c.req.query("sinceHours") ?? 24);
  return c.json({
    ok: true,
    summary: telemetrySink.summary(Number.isFinite(sinceHours) ? sinceHours : 24),
    recent: telemetrySink.recent(Number.isFinite(limit) ? Math.min(limit, 200) : 50),
    // MEM-03: pending/consolidated/dead-letter counts + last-pass status.
    // Best-effort read — degrades to null rather than a 503 (unlike
    // /consolidate, which is an explicit action) when memory failed to init.
    memory: memory ? memory.store.getConsolidationHealth() : null,
  });
});

app.get("/status", (c) => {
  const s = gateway.status();
  return c.json({
    ok: true,
    model: {
      id: s.id,
      state: s.state,
      target: s.target,
      ramHeadroomGB: s.ramHeadroomGB,
      fallbackActive: s.fallbackActive,
    },
  });
});

/**
 * POST /warmup
 * Pre-loads the default local chat model so the first voice turn pays a reduced
 * cold-start cost. Called by the voice orchestrator on wake-word detection.
 * Returns { ok, state, modelId }.
 */
app.post("/warmup", async (c) => {
  let entry: ReturnType<typeof gateway.registry.defaultFor> | undefined;
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
      error: errMsg(err),
    }, 503);
  }
  const state = gateway.modelManager.getState();
  return c.json({ ok: true, state, modelId: entry.id });
});

/**
 * POST /consolidate
 * Manually run a memory-consolidation pass — promotes turns captured this
 * session into the retrievable graph so they can be recalled immediately,
 * instead of waiting for the background scheduler. Returns the run summary, or
 * status "busy" if one is already in flight.
 */
app.post("/consolidate", async (c) => {
  if (!memory || !consolidationScheduler) {
    return c.json({ ok: false, error: "Memory system not available" }, 503);
  }
  const res = await consolidationScheduler.runNow("manual");
  if (res.status === "busy") {
    return c.json({ ok: true, status: "busy" });
  }
  if (res.status === "failed") {
    return c.json({ ok: false, status: "failed", error: res.error }, 500);
  }
  return c.json({ ok: true, status: "ran", run: res.result.run });
});

const chatBodySchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
});

app.post("/chat", async (c) => {
  const body = await readJsonBody(c);
  if (body === INVALID_JSON) {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.message }, 400);
  }
  const { message, conversationId } = parsed.data;

  // Bridge client disconnects to the upstream generation via AbortController.
  const ac = new AbortController();

  setSseHeaders(c);

  return stream(c, async (s) => {
    s.onAbort(() => ac.abort());
    const send = async (obj: unknown) => {
      await s.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    try {
      for await (const ev of chatCore.send({ message, conversationId }, ac.signal)) {
        if (ev.type === "status") {
          await send({ type: "status", state: ev.state });
        } else if (ev.type === "token") {
          await send({ type: "token", text: ev.text });
        } else if (ev.type === "done") {
          await send({
            type: "done",
            conversationId: ev.conversationId,
            messageId: ev.messageId,
          });
        } else if (ev.type === "error") {
          await send({ type: "error", message: ev.message });
        }
      }
    } catch (err) {
      await send({ type: "error", message: errMsg(err) });
    }
  });
});

// ── Agent system (lazy, degrades gracefully) ──────────────────────────────────

// Live bootstrap runs ONCE at startup: wires real integrations, starts the
// memory ingest bridge, and registers + starts proactive triggers. It is
// memoized (success or failure) and skipped under vitest /
// JARVIS_DISABLE_LIVE_AGENT=1, so tests still see 503 until they inject via
// setAgentSystem(). The per-request resolution below prefers an injected
// singleton, then falls back to the (memoized) bootstrap result.
bootstrapLiveAgent(gateway);
const currentAgentBag = () => getAgentSystem(gateway, null) ?? bootstrapLiveAgent(gateway);

/**
 * Resolve the agent bag and run `handler` with it, or answer 503 if the agent
 * system is unavailable. Centralizes the guard every /agent, /approvals/*, and
 * /audit route would otherwise repeat.
 */
function withAgentBag(
  c: Context,
  handler: (bag: NonNullable<ReturnType<typeof currentAgentBag>>) => Response | Promise<Response>,
): Response | Promise<Response> {
  const agentBag = currentAgentBag();
  if (!agentBag) {
    return c.json({ ok: false, error: "Agent system not available" }, 503);
  }
  return handler(agentBag);
}

const agentBodySchema = z.object({
  goal: z.string().min(1),
});

app.post("/agent", (c) =>
  withAgentBag(c, async (agentBag) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON) {
      return c.json({ ok: false, error: "Invalid JSON body" }, 400);
    }
    const parsed = agentBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    const { goal } = parsed.data;

    setSseHeaders(c);

    return stream(c, async (s) => {
      const send = async (obj: unknown) => {
        await s.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      try {
        await send({ type: "status", state: "planning" });
        const result = await agentBag.agentSystem.agent.run(goal, { source: "chat" });
        await send({ type: "done", runId: result.run.id, status: result.run.status, result: result.run.result });
      } catch (err) {
        await send({ type: "error", message: errMsg(err) });
      }
    });
  }),
);

app.get("/approvals", (c) =>
  withAgentBag(c, (agentBag) =>
    c.json({ ok: true, pending: agentBag.approvalQueue.list() }),
  ),
);

app.post("/approvals/:id/approve", (c) =>
  withAgentBag(c, (agentBag) => {
    const requestId = c.req.param("id");
    const ok = agentBag.approvalQueue.approve(requestId, "user");
    if (!ok) {
      return c.json({ ok: false, error: `Approval request not found: ${requestId}` }, 404);
    }
    return c.json({ ok: true, requestId, status: "approved" });
  }),
);

app.post("/approvals/:id/reject", (c) =>
  withAgentBag(c, (agentBag) => {
    const requestId = c.req.param("id");
    const ok = agentBag.approvalQueue.reject(requestId, "user");
    if (!ok) {
      return c.json({ ok: false, error: `Approval request not found: ${requestId}` }, 404);
    }
    return c.json({ ok: true, requestId, status: "rejected" });
  }),
);

app.get("/audit", (c) =>
  withAgentBag(c, (agentBag) => {
    try {
      const verify = agentBag.agentSystem.audit.verifyChain();
      const count = agentBag.agentSystem.audit.count;
      return c.json({ ok: true, count, chainValid: verify.ok, brokenAt: verify.brokenAt ?? null });
    } catch (err) {
      return c.json({ ok: false, error: errMsg(err) }, 500);
    }
  }),
);

// ── Voice session (dashboard HUD: features 7+8 hands-free mode) ──────────────

// Resolved per request so tests can inject a fake-built manager via
// setVoiceSessionManager() (same pattern as the agent bag above). The default
// factory only wires constructors — nothing spawns until /voice/start.
const currentVoiceSession = () =>
  getVoiceSessionManager(createDefaultVoiceSessionManager)!;

app.post("/voice/start", async (c) => {
  const result = await currentVoiceSession().start();
  return result.ok ? c.json(result) : c.json(result, 503);
});

app.post("/voice/stop", async (c) => {
  const status = await currentVoiceSession().stop();
  return c.json({ ok: true, status });
});

app.get("/voice/status", (c) => {
  return c.json({ ok: true, status: currentVoiceSession().status() });
});

// The Python sidecar's wakeword.py POSTs:
//   { event: "wake", id, source: "wakeword", phrase, confidence, ts, device_id }
// Map snake_case fields onto the TS WakeEvent shape.
const wakePayloadSchema = z.object({
  event: z.string().optional(),
  id: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  ts: z.number().optional(),
  device_id: z.string().optional(),
});

app.post("/voice/wake", async (c) => {
  const body = await readJsonBody(c);
  if (body === INVALID_JSON) {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const parsed = wakePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.message }, 400);
  }
  const p = parsed.data;
  const wake: WakeEvent = {
    id: p.id ?? randomUUID(),
    source: "wakeword",
    phrase: "Hey Jarvis",
    confidence: p.confidence ?? 1,
    timestamp: p.ts ?? Date.now(),
    deviceId: p.device_id ?? "sidecar",
    warmTriggered: false,
  };
  const accepted = currentVoiceSession().dispatchWake(wake);
  return c.json({ ok: true, accepted });
});

app.get("/voice/events", (c) => {
  const session = currentVoiceSession();
  setSseHeaders(c);

  return stream(c, async (s) => {
    const send = async (obj: unknown) => {
      await s.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    let open = true;
    let notify: (() => void) | null = null;
    const queue: VoiceEventFrame[] = [];
    // Subscribe BEFORE snapshotting so no frame falls in the gap; the client
    // dedupes overlap by seq.
    const unsubscribe = session.subscribe((frame) => {
      queue.push(frame);
      notify?.();
      notify = null;
    });
    // Comment heartbeat keeps proxies/browsers from timing the stream out.
    const heartbeat = setInterval(() => {
      void s.write(`: hb\n\n`).catch(() => undefined);
    }, 15_000);
    heartbeat.unref?.();
    s.onAbort(() => {
      open = false;
      notify?.();
      notify = null;
    });

    try {
      await send({ type: "voice_status", ...session.status() });
      for (const frame of session.recentEvents()) {
        await send({ type: "voice_event", ...frame });
      }
      while (open) {
        while (open && queue.length > 0) {
          const frame = queue.shift();
          if (frame) await send({ type: "voice_event", ...frame });
        }
        if (!open) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      // Cleanup must run on abort AND on any throw — a leaked subscriber would
      // accumulate per dashboard reconnect.
      unsubscribe();
      clearInterval(heartbeat);
    }
  });
});

const port = config.env.corePort;
// Only bind the port when run as the core process. Vitest sets VITEST, so tests
// can import this module (for the exported app/gateway/chatCore) without the
// server starting to listen.
if (!process.env["VITEST"]) {
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
    console.error(`[core] Jarvis core listening on http://127.0.0.1:${info.port}`);
    console.error(`[core] MLX sidecar: ${config.env.mlxSidecarUrl}`);
    console.error(
      `[core] HF endpoint: ${config.env.hfEndpointUrl ?? "(not configured)"}`,
    );
  });

  // Stop the voice session on exit so the sidecar's wake listener (system mic)
  // doesn't keep firing at a dead core. Best effort with a hard deadline.
  const shutdown = (): void => {
    const session = getVoiceSessionManager();
    if (!session) process.exit(0);
    const deadline = setTimeout(() => process.exit(0), 3_000);
    deadline.unref?.();
    void session
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export { app, gateway, chatCore, store, currentAgentBag, memory, consolidationScheduler };
