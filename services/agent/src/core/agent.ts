/**
 * AgentRunner — orchestrates plan → react loop, persists state, returns result.
 *
 * This is the top-level agent entry point. It:
 *   1. Creates an AgentRun and initial AgentState.
 *   2. Calls producePlan() to get an ordered plan.
 *   3. For each plan step, runs the ReAct loop.
 *   4. Checkpoints state after each step.
 *   5. Returns the final result + audit references.
 *
 * Resume: if runId is provided and a checkpoint exists, resumes from that state.
 *
 * NOTE(future): In LangGraph.js, this is replaced by agentApp.invoke() /
 * agentApp.stream() with { configurable: { thread_id: runId } }. The
 * Checkpointer here maps to SqliteSaver. The plan-and-react structure maps
 * to the graph topology.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  AgentState,
  LlmClient,
  ToolRegistry,
  ApprovalSink,
  Clock,
  UserContextProvider,
} from "../types.js";
import { Checkpointer } from "./checkpointer.js";
import { producePlan } from "./planner.js";
import { runReactLoop } from "./reactLoop.js";
import { ApprovalService } from "../safety/approval.js";
import { AuditLog } from "../safety/audit.js";

export interface AgentRunnerOptions {
  llm: LlmClient;
  tools: ToolRegistry;
  checkpointer: Checkpointer;
  approvalService: ApprovalService;
  auditLog: AuditLog;
  clock: Clock;
  /** Feature 20: optional profile-context provider (resolved once per run). */
  userContext?: UserContextProvider;
}

const USER_CONTEXT_MAX_CHARS = 1_200;

/** Resolve the user-context provider; failures and oversize degrade silently. */
async function resolveUserContext(
  provider: UserContextProvider | undefined,
  goal: string,
): Promise<string> {
  if (!provider) return "";
  try {
    const raw = await provider(goal);
    return raw.length > USER_CONTEXT_MAX_CHARS
      ? raw.slice(0, USER_CONTEXT_MAX_CHARS)
      : raw;
  } catch {
    return "";
  }
}

export interface AgentRunResult {
  run: AgentRun;
  state: AgentState;
}

/**
 * The run's result is the payload of the last successful observation. A failed
 * or absent final observation leaves `run.result` undefined (callers treat that
 * as "no result"). Centralized so the resume and finalize paths agree.
 */
function lastSuccessfulResult(state: AgentState): unknown {
  const lastObs = state.observations[state.observations.length - 1];
  return lastObs?.ok ? lastObs.result : undefined;
}

export class AgentRunner {
  constructor(private opts: AgentRunnerOptions) {}

  /** Run a new goal or resume from an existing runId. */
  async run(
    goal: string,
    runOpts: {
      source?: AgentRun["source"];
      runId?: string;
    } = {},
  ): Promise<AgentRunResult> {
    const { llm, tools, checkpointer, approvalService, auditLog, clock } = this.opts;
    const runId = runOpts.runId ?? randomUUID();
    const source = runOpts.source ?? "manual";
    const userContext = await resolveUserContext(this.opts.userContext, goal);

    // ── Check for existing checkpoint (resume) ────────────────────────────
    const existing = checkpointer.load(runId);
    let state: AgentState;
    let run: AgentRun;

    if (existing) {
      state = existing.state;
      run = {
        id: runId,
        goal: state.goal,
        source,
        status: state.status,
        plan: state.plan,
        currentStep: state.currentStep,
        createdAt: clock.isoNow(),
        updatedAt: clock.isoNow(),
      };

      // Terminal checkpoint: never re-execute a finished run — resuming a
      // "done" run would replay side-effecting steps.
      if (state.status === "done" || state.status === "error") {
        run.result = lastSuccessfulResult(state);
        return { run, state };
      }
    } else {
      // ── New run ───────────────────────────────────────────────────────────
      state = {
        goal,
        plan: [],
        currentStep: 0,
        scratchpad: [],
        observations: [],
        stepCount: 0,
        validationRetries: 0,
        reflections: [],
        routeTier: "local",
        status: "planning",
      };

      run = {
        id: runId,
        goal,
        source,
        status: "planning",
        plan: [],
        currentStep: 0,
        createdAt: clock.isoNow(),
        updatedAt: clock.isoNow(),
      };

      // ── Plan ──────────────────────────────────────────────────────────────
      auditLog.append({
        kind: "classified",
        actionId: runId,
        runId,
        payload: { event: "run.started", goal },
      });

      state.plan = await producePlan(llm, goal, userContext ? [userContext] : []);
      run.plan = state.plan;
      checkpointer.save(runId, 0, state);
    }

    // ── Execute each plan step ─────────────────────────────────────────────
    for (let i = state.currentStep; i < state.plan.length; i++) {
      const stepDesc = state.plan[i]!;
      state.currentStep = i;
      state.status = "running";
      run.status = "running";
      run.currentStep = i;

      await runReactLoop(state, stepDesc, {
        llm,
        tools,
        approvalService,
        auditLog,
        clock,
        runId,
        userContext,
      });

      const finalStatus = state.status as string;
      if (finalStatus === "error" || finalStatus === "awaiting-approval") {
        // Step did NOT complete: keep currentStep at i so a resume retries it
        // (error is terminal anyway — see resume guard above).
        checkpointer.save(runId, i + 1, state);
        break;
      }

      // Step completed: advance the step pointer BEFORE checkpointing so a
      // resume never re-executes a completed step (duplicate side effects).
      state.currentStep = i + 1;
      if (i + 1 < state.plan.length) {
        // Mid-plan "done" is only step-local — persist as running so an
        // interrupted run resumes instead of being treated as terminal.
        state.status = "running";
      }
      checkpointer.save(runId, i + 1, state);

      // Reset per-step counters
      state.validationRetries = 0;
      state.reflections = [];
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    const currentStatus = state.status as string;
    if (currentStatus === "running" || currentStatus === "done") {
      state.status = "done";
    }

    // Extract the final result from the last observation.
    run.result = lastSuccessfulResult(state);

    run.status = state.status;
    run.updatedAt = clock.isoNow();

    auditLog.append({
      kind: "executed",
      actionId: runId,
      runId,
      payload: { event: "run.finished", status: state.status, result: run.result },
    });

    return { run, state };
  }
}
