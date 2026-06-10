/**
 * AgentLlm — implements @jarvis/agent's LlmClient interface backed by the
 * InferenceGateway with taskHint:'agent' (escalates to HF per routing).
 *
 * Adapted from src/memory/gatewayLlm.ts (consolidation path) but uses the
 * 'agent' task hint so the router picks the cloud model for multi-step
 * reasoning above the local context cap.
 */

import type { LlmClient, ToolSpec } from "@jarvis/agent";
import type { InferenceGateway } from "../inference/gateway.js";

export class AgentLlm implements LlmClient {
  constructor(private readonly gateway: InferenceGateway) {}

  async complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
    tools?: ToolSpec[];
  }): Promise<string> {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: opts.prompt });

    let result = "";
    // Use 'agent' task hint — routes to HF cloud model per agentLatencyBudgetMs routing.
    for await (const chunk of this.gateway.chat({
      messages,
      stream: true,
      taskHint: "agent",
    })) {
      if (chunk.type === "token") {
        result += chunk.text;
      } else if (chunk.type === "error") {
        throw new Error(`AgentLlm: inference error: ${chunk.message}`);
      }
    }
    return result;
  }
}
