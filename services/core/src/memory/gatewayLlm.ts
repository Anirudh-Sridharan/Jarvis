/**
 * GatewayLlm — implements @jarvis/memory's LlmClient interface by calling the
 * InferenceGateway with a "consolidation" taskHint (routes to HF).
 *
 * This is used only by ConsolidationService (non-hot-path), never during
 * retrieval scoring, so latency requirements are relaxed.
 */

import type { LlmClient } from "@jarvis/memory";
import type { InferenceGateway } from "../inference/gateway.js";

/** Generous ceiling for one consolidation LLM call — a hung HF request must
 * never wedge ConsolidationScheduler.runNow forever (its `running` flag only
 * resets when the call settles). */
const DEFAULT_TIMEOUT_MS = 120_000;

export class GatewayLlm implements LlmClient {
  constructor(
    private readonly gateway: InferenceGateway,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
  }): Promise<string> {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [];

    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: opts.prompt });

    let result = "";
    // Use consolidation task hint — routes to HF cloud model. The timeout
    // signal is threaded down to the provider fetch so a hung request rejects
    // instead of hanging the consolidation pipeline indefinitely.
    for await (const chunk of this.gateway.chat(
      {
        messages,
        stream: true,
        taskHint: "consolidation",
      },
      AbortSignal.timeout(this.timeoutMs),
    )) {
      if (chunk.type === "token") {
        result += chunk.text;
      } else if (chunk.type === "error") {
        throw new Error(`GatewayLlm: inference error: ${chunk.message}`);
      }
    }
    return result;
  }
}
