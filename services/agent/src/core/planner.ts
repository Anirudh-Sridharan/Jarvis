/**
 * Plan-and-execute planner (feature 16).
 *
 * For multi-step goals, asks the LLM to decompose the goal into an ordered plan.
 * For trivially single-step goals (short, single-action requests), returns a
 * single-item plan to avoid the overhead.
 *
 * Re-plans on divergence: if a step fails and reflection suggests a different path,
 * the planner can be called again with the updated scratchpad.
 *
 * NOTE(future): In LangGraph.js, this is the "plan" node. The plan is stored in
 * AgentState.plan and the graph iterates currentStep through it.
 */

import type { LlmClient } from "../types.js";

/** Parse a numbered/bulleted list from an LLM plan response. */
export function parsePlan(raw: string): string[] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    // strip leading numbering: "1. ", "- ", "* ", etc.
    .map((l) => l.replace(/^(?:\d+[.)]\s*|[-*]\s*)/, "").trim())
    .filter((l) => l.length > 0 && l.length < 500);

  return lines.length > 0 ? lines : [raw.trim()];
}

/** Heuristic: if the goal is short and doesn't mention multiple tasks, skip planning. */
export function isTrivialGoal(goal: string): boolean {
  const words = goal.split(/\s+/).length;
  const multiIndicators = /\band\b.*\band\b|then|after (that|which)|step|multiple|first.*then/i.test(goal);
  return words < 15 && !multiIndicators;
}

/**
 * Produce a plan for the given goal.
 * Returns string[] — may be a single item for trivial goals.
 */
export async function producePlan(
  llm: LlmClient,
  goal: string,
  context: string[] = [],
): Promise<string[]> {
  if (isTrivialGoal(goal)) {
    return [goal];
  }

  const contextNote =
    context.length > 0
      ? `\nRelevant context:\n${context.slice(-3).join("\n")}\n`
      : "";

  const prompt =
    `You are a planning agent. Decompose the following goal into an ordered list of concrete steps.\n` +
    `Goal: ${goal}${contextNote}\n\n` +
    `Output ONLY a numbered list of steps (1-7 items). Each step should be a single concrete action.\n` +
    `Example:\n1. Search for relevant emails\n2. Draft a reply\n3. Request approval and send`;

  const raw = await llm.complete({ prompt });
  const plan = parsePlan(raw);

  // Fallback: if plan is empty or absurd, return single-step
  if (plan.length === 0 || plan.length > 20) {
    return [goal];
  }

  return plan;
}

/**
 * Re-plan after divergence.
 * Incorporates what has already been done (completed steps + observations).
 */
export async function replan(
  llm: LlmClient,
  goal: string,
  completedSteps: string[],
  remainingSteps: string[],
  failureReason: string,
): Promise<string[]> {
  const prompt =
    `Goal: ${goal}\n\n` +
    `Completed steps:\n${completedSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    `Original remaining plan:\n${remainingSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    `Divergence: ${failureReason}\n\n` +
    `Revise the remaining steps to recover from this divergence.\n` +
    `Output ONLY a numbered list of revised remaining steps.`;

  const raw = await llm.complete({ prompt });
  return parsePlan(raw);
}
