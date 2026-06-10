/**
 * bootstrapLiveAgent — wires live integrations (real fetch HttpClient + macOS
 * Keychain TokenStore) into the agent-system singleton so /agent and
 * /approvals work in a live `npm run core` without a separate daemon entry.
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

export function bootstrapLiveAgent(gateway: InferenceGateway): AgentSystemBag | null {
  if (process.env["VITEST"] || process.env["JARVIS_DISABLE_LIVE_AGENT"] === "1") {
    return null;
  }
  try {
    // GatewayLlm satisfies the integrations LlmClient too (same structural
    // shape) — the morning-briefing trigger can generate via HF.
    const { system } = createLiveIntegrations({ llm: new GatewayLlm(gateway) });
    // External data → memory capture (feature 9→3 bridge): periodic, idempotent.
    const memory = getMemorySystem(gateway);
    if (memory) startIngestBridge({ memory, integrations: system });
    return getAgentSystem(gateway, system);
  } catch (err) {
    console.warn(
      "[agent] live bootstrap failed — agent endpoints disabled.",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
