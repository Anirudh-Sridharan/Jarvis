/**
 * memorySystem — singleton factory for the @jarvis/memory MemorySystem, wired
 * with GatewayEmbedder + GatewayLlm and the JARVIS_DATA_DIR.
 *
 * The singleton is created lazily on first call to getMemorySystem().
 * If construction fails (e.g. no embedding entry in registry), we log a warning
 * and return null so callers can degrade gracefully.
 */

import { createMemorySystem } from "@jarvis/memory";
import type { MemorySystem } from "@jarvis/memory";
import { GatewayEmbedder } from "./gatewayEmbedder.js";
import { GatewayLlm } from "./gatewayLlm.js";
import type { InferenceGateway } from "../inference/gateway.js";
import { homedir } from "node:os";
import { join } from "node:path";

let instance: MemorySystem | null = null;
let initialized = false;

/**
 * Return the lazily-created MemorySystem singleton.
 * Returns null (and logs) if the system cannot be set up (e.g. missing config).
 */
export function getMemorySystem(gateway: InferenceGateway): MemorySystem | null {
  if (initialized) return instance;
  initialized = true;

  try {
    const dataDir =
      process.env["JARVIS_DATA_DIR"] ?? join(homedir(), ".jarvis", "data");

    const embedder = new GatewayEmbedder(gateway.mlx, gateway.registry);
    const llm = new GatewayLlm(gateway);

    instance = createMemorySystem({ embedder, llm, dataDir });
    return instance;
  } catch (err) {
    console.warn(
      "[memory] Could not initialize MemorySystem — memory features disabled.",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Override the singleton (used in tests to inject a fake-backed system). */
export function setMemorySystem(ms: MemorySystem | null): void {
  instance = ms;
  initialized = true;
}

/** Reset the singleton (used in tests). */
export function resetMemorySystem(): void {
  instance = null;
  initialized = false;
}
