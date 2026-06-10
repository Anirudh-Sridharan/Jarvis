/**
 * Token estimator shared by the router and the chat context budget.
 *
 * Backed by a real BPE tokenizer (gpt-tokenizer, cl100k_base) as a close
 * proxy for Qwen's byte-level BPE — typically within a few percent, versus
 * the old chars/4 heuristic's ±15-25%. Still an ESTIMATE for Qwen (exact
 * counts live in the MLX sidecar), which is why the budget path fails OVER
 * to HF rather than truncating silently (feature 1 "Token estimation error").
 */
import { countTokens as bpeCountTokens } from "gpt-tokenizer/encoding/cl100k_base";
import type { ChatMessage, ToolSpec } from "./types.js";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return bpeCountTokens(text);
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
