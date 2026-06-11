/**
 * Live wiring for @jarvis/integrations: real fetch HttpClient, macOS Keychain
 * TokenStore, real clock. This is the core-side counterpart of the package's
 * createIntegrations({...fakes}) test wiring.
 *
 * The LLM (briefing generation) is optional — the connect/sync CLI does not
 * need it, so the default is a client that fails loudly if something tries to
 * generate a briefing without a gateway-backed LLM injected. The server's
 * liveBootstrap passes a GatewayLlm so the morning-briefing trigger works.
 */

import {
  createIntegrations,
  type IntegrationsSystem,
  type LlmClient,
} from "@jarvis/integrations";
import { getDataDir } from "../dataDir.js";

export { getDataDir };
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
