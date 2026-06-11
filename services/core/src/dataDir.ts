/**
 * Single source of truth for the on-disk data directory: JARVIS_DATA_DIR (set
 * in .env) or ~/.jarvis/data. Every store (conversations, telemetry, memory,
 * agent, integrations) must resolve through here — divergent resolution gives
 * each process its own database (sync writes one store, chat reads another).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  return process.env["JARVIS_DATA_DIR"] ?? join(homedir(), ".jarvis", "data");
}
