/**
 * bootstrapLiveAgent — wires live integrations (real fetch HttpClient + macOS
 * Keychain TokenStore) into the agent-system singleton, starts the memory
 * ingest bridge, and registers + starts the proactive triggers (nightly
 * consolidation, morning briefing). Called once at server startup; the lazy
 * per-request fallback hits the memoized result.
 *
 * The attempt is MEMOIZED: success or failure, it runs exactly once per
 * process — a failed attempt must not re-open integrations (SQLite handles,
 * Keychain wiring) on every subsequent request.
 *
 * Skipped under vitest (tests inject via setAgentSystem and must see 503
 * before doing so) and when JARVIS_DISABLE_LIVE_AGENT=1.
 *
 * Failure is non-fatal: returns null and the server keeps its existing
 * graceful degradation (agent endpoints 503).
 */

import type { InferenceGateway } from "../inference/gateway.js";
import { getAgentSystem, type AgentSystemBag } from "./agentSystem.js";
import { createLiveIntegrations } from "../integrations/liveIntegrations.js";
import { getMemorySystem } from "../memory/memorySystem.js";
import { startIngestBridge } from "../memory/ingestBridge.js";
import { GatewayLlm } from "../memory/gatewayLlm.js";
import { registerProactiveTriggers } from "./proactiveBootstrap.js";

import type { CalendarMirror } from "@jarvis/integrations";

let attempted = false;
let cachedBag: AgentSystemBag | null = null;
let cachedCalendarMirror: CalendarMirror | null = null;

/**
 * Live calendar mirror for the chat agenda block. Triggers the (memoized)
 * live bootstrap on first use; survives agent-bag failure — calendar reads
 * only need the integrations store, not the full agent system.
 */
export function getLiveCalendarMirror(gateway: InferenceGateway): CalendarMirror | null {
  bootstrapLiveAgent(gateway);
  return cachedCalendarMirror;
}

export function bootstrapLiveAgent(gateway: InferenceGateway): AgentSystemBag | null {
  if (process.env["VITEST"] || process.env["JARVIS_DISABLE_LIVE_AGENT"] === "1") {
    return null;
  }
  if (attempted) return cachedBag;
  attempted = true;

  try {
    // GatewayLlm satisfies the integrations LlmClient too (same structural
    // shape) — the morning-briefing trigger can generate via HF.
    const { system } = createLiveIntegrations({ llm: new GatewayLlm(gateway) });
    cachedCalendarMirror = system.calendar.mirror;
    // Memory first: the agent system grounds its runs in the profile (feature 20).
    const memory = getMemorySystem(gateway);
    const bag = getAgentSystem(gateway, system, memory);
    if (!bag) return null; // getAgentSystem already logged; stay memoized-null
    if (memory) {
      // External data → memory capture (feature 9→3 bridge): periodic, idempotent.
      startIngestBridge({ memory, integrations: system });
      // Proactive triggers (nightly consolidation, morning briefing) + live cron.
      registerProactiveTriggers({
        agentSystem: bag.agentSystem,
        integrations: system,
        memory,
      });
      void bag.agentSystem.triggers.start().catch((err: unknown) => {
        console.warn(
          "[agent] proactive scheduler failed to start:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    cachedBag = bag;
    return bag;
  } catch (err) {
    console.warn(
      "[agent] live bootstrap failed — agent endpoints disabled.",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Reset the memoized attempt (tests only). */
export function resetLiveBootstrap(): void {
  attempted = false;
  cachedBag = null;
  cachedCalendarMirror = null;
}
