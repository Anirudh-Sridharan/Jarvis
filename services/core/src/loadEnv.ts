/**
 * Side-effect module: load the repo-root `.env` into process.env on import.
 *
 * Import this FIRST in any executable entrypoint (server, CLI) so config.ts —
 * which reads process.env directly — sees HF_ENDPOINT_URL/HF_TOKEN/etc. without
 * the caller having to `source .env` manually.
 *
 * Uses Node's built-in `process.loadEnvFile` (no dependency). It does NOT
 * override variables already present in the environment, so explicit shell
 * exports and test-injected vars still take precedence. A missing .env is fine
 * (vars may be set some other way) — we swallow the error.
 *
 * NOT imported by config.ts: loadConfig() is called directly by tests, which
 * must not pick up a developer's local .env as a side effect.
 *
 * Path resolves the same way as config/models.yaml — relative to this file, so
 * it works whether run via tsx (src/) or compiled (dist/):
 *   src|dist/loadEnv -> services/core -> services -> <root>/.env
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(here, "..", "..", "..", ".env");

try {
  process.loadEnvFile(rootEnvPath);
} catch {
  // No .env (or unreadable) — fine; env may be provided directly.
}
