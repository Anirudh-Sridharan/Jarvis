/**
 * Live wiring for @jarvis/integrations: real fetch HttpClient, macOS Keychain
 * TokenStore, real clock. This is the core-side counterpart of the package's
 * createIntegrations({...fakes}) test wiring.
 *
 * The LLM (briefing generation) is optional — the connect/sync CLI does not
 * need it, so the default is a client that fails loudly if something tries to
 * generate a briefing without a gateway-backed LLM injected.
 * TODO(phase4: feature 15): wire the InferenceGateway LLM here when the
 * briefing scheduler goes live in the server process.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  createIntegrations,
  type IntegrationsSystem,
  type LlmClient,
} from "@jarvis/integrations";
import { FetchHttpClient } from "./fetchHttp.js";
import { KeychainTokenStore } from "./keychainTokenStore.js";

const unavailableLlm: LlmClient = {
  async complete(): Promise<string> {
    throw new Error(
      "No LLM wired into live integrations (briefing generation requires the gateway).",
    );
  },
};

export interface LiveIntegrationsOptions {
  llm?: LlmClient;
  dataDir?: string;
}

export function getDataDir(): string {
  return process.env["JARVIS_DATA_DIR"] ?? join(homedir(), ".jarvis", "data");
}

export function createLiveIntegrations(
  opts: LiveIntegrationsOptions = {},
): { system: IntegrationsSystem; http: FetchHttpClient; tokenStore: KeychainTokenStore } {
  const http = new FetchHttpClient();
  const tokenStore = new KeychainTokenStore();
  const system = createIntegrations({
    http,
    clock: { now: () => Date.now() },
    tokenStore,
    llm: opts.llm ?? unavailableLlm,
    dataDir: opts.dataDir ?? getDataDir(),
  });
  return { system, http, tokenStore };
}
