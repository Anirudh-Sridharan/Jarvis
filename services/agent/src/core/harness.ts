/**
 * Validate-and-retry harness (feature 16).
 *
 * This is the core reliability piece: raw local-model tool-calling can emit
 * valid JSON <7% of the time without help; with this harness + error feedback
 * we drive it to ~100%.
 *
 * Algorithm:
 *   1. Ask the LLM to emit a tool call.
 *   2. Parse the response: expect JSON { tool, args } or { name, arguments }.
 *   3. Validate args against the tool's zod schema.
 *   4. On failure: feed the exact ZodError back to the model and retry (up to maxRetries).
 *   5. On exhaustion: return { aborted: "invalid-tool" }.
 *
 * NOTE(future): In the LangGraph.js production swap, this function becomes the
 * "validate" node with guided/structured decoding on the hermes-style tool-call
 * format. The zod schemas here map 1-to-1 with the JSON Schema specs exposed via MCP.
 */

import { z } from "zod";
import type { LlmClient, Tool } from "../types.js";

export const MAX_VALIDATION_RETRIES = 3;

export interface HarnessSuccess {
  toolName: string;
  args: unknown;
  attempts: number;
}

export interface HarnessAbort {
  aborted: "invalid-tool" | "tool-not-found" | "no-tool-emitted";
  reason: string;
}

export type HarnessResult = HarnessSuccess | HarnessAbort;

export function isAborted(r: HarnessResult): r is HarnessAbort {
  return "aborted" in r;
}

/**
 * Parse a raw LLM response string into { tool, args }.
 * Accepts two common hermes/openai formats:
 *   { "tool": "name", "args": {...} }
 *   { "name": "name", "arguments": {...} }
 * Returns null if neither matches.
 */
export function parseLlmToolCall(
  raw: string,
): { tool: string; args: Record<string, unknown> } | null {
  const cleaned = raw.trim();
  // extract JSON from a code block if present
  const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = codeBlock ? codeBlock[1]!.trim() : cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  // hermes format: { tool, args }
  if (typeof p["tool"] === "string") {
    return {
      tool: p["tool"],
      args: (typeof p["args"] === "object" && p["args"] !== null
        ? p["args"]
        : {}) as Record<string, unknown>,
    };
  }

  // openai format: { name, arguments }
  if (typeof p["name"] === "string") {
    const rawArgs = p["arguments"];
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      args = rawArgs as Record<string, unknown>;
    }
    return { tool: p["name"], args };
  }

  return null;
}

/**
 * Build a prompt that instructs the LLM to emit a tool call.
 */
export function buildToolCallPrompt(
  goal: string,
  scratchpad: string[],
  tools: Tool[],
): string {
  const toolDefs = tools
    .map((t) => {
      const shape = t.schema._def;
      return `- ${t.name}: ${t.description}`;
    })
    .join("\n");

  const scratch =
    scratchpad.length > 0
      ? `\nPrevious steps:\n${scratchpad.join("\n")}\n`
      : "";

  return (
    `You are a reasoning agent. Your goal: ${goal}` +
    scratch +
    `\n\nAvailable tools:\n${toolDefs}\n\n` +
    `Respond with ONLY a JSON object in this format:\n` +
    `{"tool": "<tool_name>", "args": {<arguments>}}\n` +
    `If the goal is complete, respond with:\n` +
    `{"tool": "__done__", "args": {"result": "<final answer>"}}`
  );
}

/**
 * The validate-and-retry harness.
 *
 * Drives the LLM to produce a valid tool call for the given goal+scratchpad,
 * retrying with ZodError feedback on validation failure.
 */
export async function validateAndRetry(opts: {
  llm: LlmClient;
  goal: string;
  scratchpad: string[];
  tools: ToolRegistry;
  maxRetries?: number;
}): Promise<HarnessResult> {
  const { llm, goal, scratchpad, tools, maxRetries = MAX_VALIDATION_RETRIES } =
    opts;
  const toolList = [...tools.values()];
  const feedback: string[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const feedbackNote =
      feedback.length > 0
        ? `\n\nPrevious attempt failed:\n${feedback[feedback.length - 1]}\nPlease correct and try again.`
        : "";

    const prompt = buildToolCallPrompt(goal, scratchpad, toolList) + feedbackNote;
    const raw = await llm.complete({ prompt });

    // 1. Parse
    const parsed = parseLlmToolCall(raw);
    if (!parsed) {
      feedback.push(
        `Attempt ${attempt}: Could not parse JSON tool call from response. ` +
          `Ensure your response is valid JSON with "tool" and "args" keys.`,
      );
      continue;
    }

    // 2. Check tool exists
    const tool = tools.get(parsed.tool);
    if (!tool) {
      if (parsed.tool === "__done__") {
        // synthetic "done" tool
        return { toolName: "__done__", args: parsed.args, attempts: attempt };
      }
      feedback.push(
        `Attempt ${attempt}: Unknown tool "${parsed.tool}". ` +
          `Available tools: ${toolList.map((t) => t.name).join(", ")}`,
      );
      continue;
    }

    // 3. Validate args against zod schema
    const validation = tool.schema.safeParse(parsed.args);
    if (!validation.success) {
      const issues = validation.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      feedback.push(
        `Attempt ${attempt}: Arguments for "${parsed.tool}" failed schema validation:\n` +
          `${issues}\n` +
          `Return corrected arguments only.`,
      );
      continue;
    }

    // 4. Success
    return {
      toolName: parsed.tool,
      args: validation.data,
      attempts: attempt,
    };
  }

  return {
    aborted: "invalid-tool",
    reason: `Exhausted ${maxRetries} retries. Last error: ${feedback[feedback.length - 1] ?? "unknown"}`,
  };
}

// Re-export for convenience
type ToolRegistry = Map<string, Tool>;
