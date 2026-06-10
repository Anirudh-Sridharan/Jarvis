/**
 * Server-only BFF service layer — feature 14.
 *
 * Lazily constructs READ instances of @jarvis/integrations and @jarvis/memory
 * pointed at JARVIS_DATA_DIR (default ~/.jarvis/data).
 *
 * No-op stubs are injected for http / tokenStore / llm so that these instances
 * only touch the local SQLite DBs (safe for read-only dashboard queries).
 *
 * TODO(future): move BFF to the core daemon to avoid two processes writing the
 * same SQLite. For now, reads are safe (WAL mode, no writes from dashboard).
 */

// Server-only guard — Next.js will error if this is imported in a client component
import "server-only";

import os from "node:os";
import path from "node:path";
import { findRepoRoot } from "./repoRoot";
import { createIntegrations } from "@jarvis/integrations";
import type { IntegrationsSystem } from "@jarvis/integrations";
import { createMemorySystem } from "@jarvis/memory";
import type { MemorySystem } from "@jarvis/memory";
import type { HttpClient, HttpRequest, Clock, TokenStore, LlmClient, OAuthTokens, SourceId } from "@jarvis/integrations";

// ── Stubs for DI (read-only, no network) ─────────────────────────────────────

const noOpHttp: HttpClient = {
  async request(_req: HttpRequest) {
    return { status: 503, headers: {}, body: null };
  },
};

const realClock: Clock = {
  now() { return Date.now(); },
};

const noOpTokenStore: TokenStore = {
  async get(_source: SourceId): Promise<OAuthTokens | null> { return null; },
  async set(_source: SourceId, _tokens: OAuthTokens): Promise<void> {},
};

const noOpLlm: LlmClient = {
  async complete(_opts: { system?: string; prompt: string; json?: boolean }): Promise<string> {
    throw new Error("LLM not available in dashboard BFF");
  },
};

const noOpEmbedder = {
  async embed(_texts: string[]): Promise<number[][]> { return []; },
};

const noOpMemoryLlm = {
  async complete(_opts: { system?: string; prompt: string; json?: boolean }): Promise<string> {
    throw new Error("LLM not available in dashboard BFF");
  },
};

// ── Data dir resolution ───────────────────────────────────────────────────────

/**
 * Match core's resolution exactly or the dashboard reads a different (empty)
 * database than the one core/the connect CLI write. Core loads the repo .env
 * and resolves JARVIS_DATA_DIR from its own cwd (services/core) — so load the
 * same .env here, and resolve a relative value against services/core too.
 */
function getDataDir(): string {
  if (!process.env.JARVIS_DATA_DIR) {
    try {
      process.loadEnvFile(path.join(findRepoRoot(), ".env"));
    } catch {
      // no repo .env — fall through to defaults
    }
  }
  const env = process.env.JARVIS_DATA_DIR;
  if (env) {
    return path.isAbsolute(env) ? env : path.resolve(findRepoRoot(), "services/core", env);
  }
  return path.join(os.homedir(), ".jarvis", "data");
}

// ── Lazy singletons ───────────────────────────────────────────────────────────

let _integrations: IntegrationsSystem | null = null;
let _memory: MemorySystem | null = null;

export function getIntegrations(): IntegrationsSystem {
  if (!_integrations) {
    _integrations = createIntegrations({
      http: noOpHttp,
      clock: realClock,
      tokenStore: noOpTokenStore,
      llm: noOpLlm,
      dataDir: getDataDir(),
    });
  }
  return _integrations;
}

export function getMemory(): MemorySystem {
  if (!_memory) {
    _memory = createMemorySystem({
      embedder: noOpEmbedder,
      llm: noOpMemoryLlm,
      dataDir: getDataDir(),
    });
  }
  return _memory;
}
