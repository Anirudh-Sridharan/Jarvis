/**
 * ReAct loop (feature 16): think → tool-call → [approval gate] → execute → observe → repeat.
 *
 * Implements:
 *   - ReAct (Reason + Act) pattern per step
 *   - max-steps loop guard (MAX_STEPS = 25)
 *   - Reflexion-style reflection on failure
 *   - Approval gate integration (reads decision from ApprovalSink)
 *   - Observation accumulation
 *
 * NOTE(future): In the LangGraph.js production swap, each phase here becomes a
 * named node in a StateGraph with addConditionalEdges. interrupt() is called in
 * the "approve" node; the graph pauses and resumes via Command(resume=...).
 * The logic is mechanically equivalent — just restructured as a graph.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentState,
  LlmClient,
  ToolRegistry,
  ApprovalSink,
  Observation,
  Clock,
} from "../types.js";
import { validateAndRetry, isAborted } from "./harness.js";
import { ApprovalService } from "../safety/approval.js";
import { AuditLog } from "../safety/audit.js";
import { scanToolOutput } from "../safety/injectionGuards.js";

export const MAX_STEPS = 25;

export interface ReactLoopOptions {
  llm: LlmClient;
  tools: ToolRegistry;
  approvalService: ApprovalService;
  auditLog: AuditLog;
  clock: Clock;
  /** The actual agent run id — used for approval/audit records. */
  runId: string;
  maxSteps?: number;
}

/**
 * Run the ReAct loop for a single plan step (or a whole single-step goal).
 * Mutates `state` in place, appending observations and reflections.
 * Returns when the step is complete, an error occurs, or max-steps is hit.
 */
export async function runReactLoop(
  state: AgentState,
  stepDescription: string,
  opts: ReactLoopOptions,
): Promise<void> {
  const {
    llm,
    tools,
    approvalService,
    auditLog,
    clock,
    runId,
    maxSteps = MAX_STEPS,
  } = opts;

  state.status = "running";

  while (state.stepCount < maxSteps) {
    state.stepCount += 1;

    // ── THINK + TOOL-CALL (via harness) ──────────────────────────────────────
    const harnessResult = await validateAndRetry({
      llm,
      goal: stepDescription,
      scratchpad: state.scratchpad,
      tools,
    });

    if (isAborted(harnessResult)) {
      // harness exhausted retries — reflect and possibly give up
      const reflection = await reflect(
        llm,
        stepDescription,
        state.scratchpad,
        `Tool call failed: ${harnessResult.reason}`,
      );
      state.reflections.push(reflection);
      state.scratchpad.push(`[reflection] ${reflection}`);

      if (state.reflections.length >= 3) {
        state.status = "error";
        return;
      }
      continue;
    }

    const { toolName, args, attempts } = harnessResult;

    // ── DONE sentinel ────────────────────────────────────────────────────────
    if (toolName === "__done__") {
      const doneArgs = args as Record<string, unknown>;
      const obs: Observation = {
        id: randomUUID(),
        toolCallId: "done",
        ok: true,
        result: doneArgs["result"] ?? doneArgs,
        latencyMs: 0,
        truncated: false,
      };
      state.observations.push(obs);
      state.scratchpad.push(`[done] ${String(doneArgs["result"] ?? "")}`);
      state.status = "done";
      return;
    }

    const tool = tools.get(toolName)!;
    const toolCallId = randomUUID();
    const startedAt = clock.isoNow();

    // ── APPROVAL GATE ────────────────────────────────────────────────────────
    if (!tool.readOnly) {
      const actionId = randomUUID();
      // Real provenance: if any earlier tool output contained injection
      // markers, this action is tainted — the policy's injection/taint
      // escalation (require_approval or block) must be able to fire.
      const taintFlags = state.taint?.flags ?? [];
      const action = {
        id: actionId,
        runId,
        tool: toolName,
        args: args as Record<string, unknown>,
        reasoning: stepDescription,
        provenance: {
          derivedFromExternal: taintFlags.length > 0,
          sources: state.taint?.sources ?? [],
          injectionFlags: taintFlags,
        },
        proposedAt: clock.isoNow(),
      };

      const { decision } = await approvalService.evaluateAndMaybeRequest(
        action,
        auditLog,
        clock,
      );

      if (decision.outcome === "block") {
        const obs: Observation = {
          id: randomUUID(),
          toolCallId,
          ok: false,
          error: { code: "blocked", message: decision.reasons.join("; ") },
          latencyMs: 0,
          truncated: false,
        };
        state.observations.push(obs);
        state.scratchpad.push(`[blocked] ${toolName}: ${decision.reasons.join("; ")}`);
        state.status = "error";
        return;
      }

      if (decision.outcome === "require_approval") {
        // Interrupt: pause for approval
        state.status = "awaiting-approval";
        const approvalResult = await approvalService.waitForDecision(
          actionId,
          clock,
        );

        if (!approvalResult || approvalResult.status === "rejected" || approvalResult.status === "expired") {
          const obs: Observation = {
            id: randomUUID(),
            toolCallId,
            ok: false,
            error: {
              code: approvalResult?.status ?? "rejected",
              message: `Tool ${toolName} was not approved`,
            },
            latencyMs: 0,
            truncated: false,
          };
          state.observations.push(obs);
          state.scratchpad.push(`[rejected] ${toolName}`);
          // Reflect and possibly reroute
          const reflection = await reflect(
            llm,
            stepDescription,
            state.scratchpad,
            `Action ${toolName} was rejected. Try an alternative approach.`,
          );
          state.reflections.push(reflection);
          state.scratchpad.push(`[reflection] ${reflection}`);
          state.status = "running";
          continue;
        }

        state.status = "running";
      }
    }

    // ── EXECUTE ──────────────────────────────────────────────────────────────
    const execStart = clock.now();
    let obs: Observation;
    try {
      const result = await tool.run(args);
      const latencyMs = clock.now() - execStart;

      // Injection scan on the result before feeding back to the loop.
      // Any flags taint the rest of the run: subsequent ProposedActions carry
      // them in provenance so the policy escalates/blocks (see APPROVAL GATE).
      const resultStr = JSON.stringify(result);
      const injectionFlags = scanToolOutput(resultStr);
      if (injectionFlags.length > 0) {
        state.taint = {
          flags: [...new Set([...(state.taint?.flags ?? []), ...injectionFlags])],
          sources: [...new Set([...(state.taint?.sources ?? []), toolName])],
        };
      }

      obs = {
        id: randomUUID(),
        toolCallId,
        ok: true,
        result,
        latencyMs,
        truncated: resultStr.length > 8000,
      };

      const resultSummary =
        resultStr.length > 500 ? resultStr.slice(0, 500) + "…" : resultStr;
      state.scratchpad.push(
        `[tool:${toolName}] (${latencyMs}ms) → ${resultSummary}` +
          (injectionFlags.length > 0
            ? ` ⚠️ injection flags: ${injectionFlags.join(", ")}`
            : ""),
      );
    } catch (err) {
      const latencyMs = clock.now() - execStart;
      obs = {
        id: randomUUID(),
        toolCallId,
        ok: false,
        error: {
          code: "tool-error",
          message: err instanceof Error ? err.message : String(err),
        },
        latencyMs,
        truncated: false,
      };
      state.scratchpad.push(
        `[error:${toolName}] ${obs.error?.message ?? "unknown"}`,
      );
    }

    state.observations.push(obs);

    // ── OBSERVE + REFLECT if failed ──────────────────────────────────────────
    if (!obs.ok) {
      const reflection = await reflect(
        llm,
        stepDescription,
        state.scratchpad,
        `Tool ${toolName} returned an error: ${obs.error?.message ?? "unknown"}`,
      );
      state.reflections.push(reflection);
      state.scratchpad.push(`[reflection] ${reflection}`);

      if (state.reflections.length >= 3) {
        state.status = "error";
        return;
      }
      // Loop continues to retry with reflection context
    }
  }

  // Loop guard triggered
  state.status = "error";
}

/**
 * Reflexion-style critique: given the failure context, produce a corrected plan.
 */
async function reflect(
  llm: LlmClient,
  goal: string,
  scratchpad: string[],
  failureReason: string,
): Promise<string> {
  const prompt =
    `Goal: ${goal}\n` +
    `Previous steps:\n${scratchpad.slice(-5).join("\n")}\n\n` +
    `Failure: ${failureReason}\n\n` +
    `Briefly critique what went wrong and propose a corrected next action (1-2 sentences).`;

  return llm.complete({ prompt });
}
