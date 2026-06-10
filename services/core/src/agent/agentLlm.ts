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

/** Generous ceiling for one agent LLM call — a hung HF request must not wedge
 * the ReAct loop (and any approval/run bookkeeping behind it) forever. */
const DEFAULT_TIMEOUT_MS = 120_000;

export class AgentLlm implements LlmClient {
  constructor(
    private readonly gateway: InferenceGateway,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

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
    // Use 'agent' task hint — routes to HF cloud model per agentLatencyBudgetMs
    // routing. The timeout signal is threaded down to the provider fetch so a
    // hung request rejects instead of hanging the agent loop indefinitely.
    for await (const chunk of this.gateway.chat(
      {
        messages,
        stream: true,
        taskHint: "agent",
      },
      AbortSignal.timeout(this.timeoutMs),
    )) {
      if (chunk.type === "token") {
        result += chunk.text;
      } else if (chunk.type === "error") {
        throw new Error(`AgentLlm: inference error: ${chunk.message}`);
      }
    }
    return result;
  }
}
