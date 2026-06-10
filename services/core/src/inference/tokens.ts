/**
 * Cheap token estimator shared by the router and the chat context budget.
 *
 * Phase 1 uses a chars/4 heuristic. This systematically under-estimates for some
 * scripts, which is why the budget path fails OVER to HF rather than truncating
 * silently (see feature 1 edge case "Token estimation error").
 *
 * TODO(phase2: feature 1) swap for the active model's real tokenizer
 * (MLX Qwen locally; HF tokenizer in cloud mode).
 */
import type { ChatMessage, ToolSpec } from "./types.js";

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate prompt tokens for a full request (messages + serialized tools). */
export function estimateRequestTokens(
  messages: ChatMessage[],
  tools?: ToolSpec[],
): number {
  let total = 0;
  for (const m of messages) {
    // +4 per message approximates the role/format framing overhead.
    total += estimateTokens(m.content) + 4;
  }
  if (tools && tools.length > 0) {
    total += estimateTokens(JSON.stringify(tools));
  }
  return total;
}
