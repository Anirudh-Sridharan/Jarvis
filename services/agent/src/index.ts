/**
 * @jarvis/agent — public API.
 *
 * createAgentSystem({ llm, tools, clock, dataDir, approvalSink }) returns:
 *   {
 *     agent:     AgentRunner (run goals)
 *     approvals: ApprovalService (approve/reject pending)
 *     skills:    SkillRegistry (run named skills)
 *     triggers:  Scheduler (proactive scheduling)
 *     audit:     AuditLog (query + verify chain)
 *   }
 *
 * Everything external is injected:
 *   - LlmClient: HuggingFace in prod, FakeLlm in tests
 *   - ToolRegistry: MCP-style tools, FakeTools in tests
 *   - ApprovalSink: UI bridge or test stub
 *   - Clock: real Date.now() or FixedClock in tests
 *
 * NOTE(future): When @langchain/langgraph is available, replace AgentRunner with
 * a StateGraph + SqliteSaver, and ApprovalService.waitForDecision with interrupt().
 * The injected interfaces are intentionally LangGraph-compatible.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
  // Feature 16
  AgentRun,
  Step,
  ToolCall,
  Observation,
  AgentState,
  RunStatus,
  // Feature 17
  ProposedAction,
  RiskClass,
  PolicyDecision,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalStatus,
  AuditEntry,
  Outcome,
  AllowScope,
  // Feature 18
  SkillInvocation,
  SkillResult,
  SkillAction,
  EmailDraft,
  ResearchResult,
  // Feature 19
  Trigger,
  TriggerKind,
  TriggerStatus,
  TriggerRun,
  TriggerContext,
  ScheduledJob,
  JobResult,
  EpisodicState,
  // Injected interfaces
  LlmClient,
  Tool,
  ToolRegistry,
  ToolSpec,
  ApprovalSink,
  Clock,
} from "./types.js";

// ── Core exports ──────────────────────────────────────────────────────────────

export { AgentRunner } from "./core/agent.js";
export { Checkpointer } from "./core/checkpointer.js";
export {
  validateAndRetry,
  parseLlmToolCall,
  buildToolCallPrompt,
  MAX_VALIDATION_RETRIES,
} from "./core/harness.js";
export type { HarnessResult, HarnessSuccess, HarnessAbort } from "./core/harness.js";
export { runReactLoop, MAX_STEPS } from "./core/reactLoop.js";
export { producePlan, parsePlan, replan, isTrivialGoal } from "./core/planner.js";

// ── Safety exports ────────────────────────────────────────────────────────────

export {
  classifyAndDecide,
  evalDynamicTriggers,
  DECISION_TABLE,
  registerToolMeta,
  getToolMeta,
  addKnownContact,
  isKnownContact,
} from "./safety/policy.js";
export { ApprovalService } from "./safety/approval.js";
export { AuditLog } from "./safety/audit.js";
export {
  scanForInjectionMarkers,
  scanToolOutput,
  severityForFlags,
} from "./safety/injectionGuards.js";

// ── Skills exports ────────────────────────────────────────────────────────────

export {
  SkillRegistry,
  ToolNotAllowedError,
  ToolApprovalDeniedError,
} from "./skills/registry.js";
export type { Skill, SkillCtx, ToolCallOpts } from "./skills/registry.js";
export { emailTriageSkill } from "./skills/emailTriage.js";
export { calendarSkill } from "./skills/calendarSkill.js";
export { webResearchSkill, verifyCitations } from "./skills/webResearch.js";
export { remindersSkill } from "./skills/reminders.js";

// ── Proactive exports ─────────────────────────────────────────────────────────

export { Scheduler } from "./proactive/scheduler.js";
export type { SchedulerOptions, EventBus } from "./proactive/scheduler.js";
export { TriggerStore } from "./proactive/triggers.js";
export { EpisodicStateStore } from "./proactive/episodicState.js";

// ── Factory ───────────────────────────────────────────────────────────────────

import { AgentRunner } from "./core/agent.js";
import { Checkpointer } from "./core/checkpointer.js";
import { ApprovalService } from "./safety/approval.js";
import { AuditLog } from "./safety/audit.js";
import { SkillRegistry } from "./skills/registry.js";
import { Scheduler } from "./proactive/scheduler.js";
import { emailTriageSkill } from "./skills/emailTriage.js";
import { calendarSkill } from "./skills/calendarSkill.js";
import { webResearchSkill } from "./skills/webResearch.js";
import { remindersSkill } from "./skills/reminders.js";
import type { LlmClient, ToolRegistry, Clock, ApprovalSink } from "./types.js";

export interface AgentSystemConfig {
  llm: LlmClient;
  tools: ToolRegistry;
  clock: Clock;
  dataDir: string;
  approvalSink: ApprovalSink;
  /** Optional event bus for event-triggered automation. */
  eventBus?: import("./proactive/scheduler.js").EventBus;
  /** Optional DST-aware cron parser for production use. */
  parseCronNext?: (expr: string, tz: string, after?: number) => number | null;
}

export interface AgentSystem {
  agent: AgentRunner;
  approvals: ApprovalService;
  skills: SkillRegistry;
  triggers: Scheduler;
  audit: AuditLog;
}

/**
 * Create a fully wired AgentSystem.
 *
 * @param config.llm         LLM client (FakeLlm for tests).
 * @param config.tools       Tool registry (fake tools for tests).
 * @param config.clock       Clock interface (FixedClock for tests).
 * @param config.dataDir     Directory for SQLite databases.
 * @param config.approvalSink Callback for approval requests.
 */
export function createAgentSystem(config: AgentSystemConfig): AgentSystem {
  const { llm, tools, clock, dataDir, approvalSink } = config;

  const auditLog = new AuditLog(dataDir, clock);
  const approvalService = new ApprovalService(approvalSink, clock);
  const checkpointer = new Checkpointer(dataDir);

  const agent = new AgentRunner({
    llm,
    tools,
    checkpointer,
    approvalService,
    auditLog,
    clock,
  });

  // Register default skills
  const skills = new SkillRegistry();
  skills.register(emailTriageSkill);
  skills.register(calendarSkill);
  skills.register(webResearchSkill);
  skills.register(remindersSkill);

  // The Scheduler shares the SAME auditLog/approvalService/checkpointer as the
  // rest of the system: separate instances over the same SQLite files corrupt
  // the cached audit chain tail (PRIMARY KEY conflicts) and create approval
  // requests that system.approvals can never see.
  const triggers = new Scheduler({
    dataDir,
    clock,
    llm,
    tools,
    auditLog,
    approvalService,
    checkpointer,
    eventBus: config.eventBus,
    parseCronNext: config.parseCronNext,
  });

  return { agent, approvals: approvalService, skills, triggers, audit: auditLog };
}
