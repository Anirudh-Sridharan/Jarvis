/**
 * Core domain types for the @jarvis/agent subsystem.
 *
 * Covers: AgentRun, Step, ToolCall, Observation, AgentState (feature 16),
 * ProposedAction, RiskClass, PolicyDecision, ApprovalRequest, AuditEntry (feature 17),
 * Trigger, ScheduledJob, TriggerRun, Skill (features 18, 19).
 */

// ── Feature 16 — Agent / Tool Execution Core ─────────────────────────────────

export type RunStatus =
  | "planning"
  | "running"
  | "awaiting-approval"
  | "done"
  | "error";

export interface AgentRun {
  id: string;
  goal: string;
  source: "chat" | "scheduler" | "skill" | "manual";
  status: RunStatus;
  plan: string[];
  currentStep: number;
  result?: unknown;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: string;
  runId: string;
  index: number;
  description: string;
  status: "pending" | "running" | "done" | "failed";
  toolCalls: ToolCall[];
  reflection?: string;
}

export interface ToolCall {
  id: string;
  stepId: string;
  toolName: string;
  args: unknown;
  validationAttempts: number;
  approval?: {
    required: boolean;
    decision?: "approved" | "rejected";
    by?: string;
    at?: string;
  };
  modelTier: "local" | "hf";
  startedAt: string;
  finishedAt?: string;
}

export interface Observation {
  id: string;
  toolCallId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  latencyMs: number;
  truncated: boolean;
}

/**
 * In-memory agent state threaded through the ReAct loop.
 *
 * NOTE(future): This is modeled directly from LangGraph.js AgentState channels.
 * When @langchain/langgraph is available, swap AgentRunner for a StateGraph
 * with SqliteSaver checkpointer and interrupt() for approval. The schemas and
 * checkpointer here are designed to be mechanically equivalent.
 */
export interface AgentState {
  goal: string;
  plan: string[];
  currentStep: number;
  scratchpad: string[];
  pendingToolCall?: Partial<ToolCall>;
  observations: Observation[];
  stepCount: number;
  validationRetries: number;
  reflections: string[];
  routeTier: "local" | "hf";
  status: RunStatus;
}

// ── Feature 17 — Action Approval & Safety Gate ───────────────────────────────

export type RiskClass =
  | "read_only"
  | "internal_write"
  | "outward_comm"
  | "financial"
  | "destructive"
  | "calendar_write"
  | "code_exec"
  | "browser_action";

export interface ProposedAction {
  id: string;
  runId: string;
  tool: string;
  args: Record<string, unknown>;
  reasoning: string;
  provenance: {
    derivedFromExternal: boolean;
    sources: string[];
    injectionFlags: string[];
  };
  proposedAt: string;
}

export type Outcome = "auto_allow" | "require_approval" | "block";

export interface PolicyDecision {
  actionId: string;
  riskClass: RiskClass;
  outcome: Outcome;
  reasons: string[];
  triggeredRules: string[];
  requiresDoubleConfirm: boolean;
  decidedAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface AllowScope {
  tool: string;
  match: "exact_args" | "same_recipient" | "any";
  bound?: Record<string, unknown>;
  maxAmount?: number;
  expiresAt?: string;
}

export interface ApprovalRequest {
  id: string;
  actionId: string;
  runId: string;
  riskClass: RiskClass;
  summary: string;
  args: Record<string, unknown>;
  reasoning: string;
  argsHash: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  alwaysAllowScope?: AllowScope | null;
}

export interface ApprovalDecision {
  requestId: string;
  status: Exclude<ApprovalStatus, "pending">;
  byUser: string;
  alwaysAllow?: AllowScope;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  kind:
    | "classified"
    | "decided"
    | "requested"
    | "approved"
    | "rejected"
    | "expired"
    | "executed"
    | "aborted"
    | "blocked";
  actionId: string;
  runId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

// ── Feature 18 — Task Automation & Skills ────────────────────────────────────

export interface SkillInvocation {
  skillId: string;
  args: unknown;
  goalId: string;
  source: "agent" | "proactive";
}

export interface SkillAction {
  type: string;
  status: "done" | "skipped" | "failed";
  target?: string;
  reason?: string;
}

export interface SkillResult {
  skillId: string;
  status: "ok" | "clarify" | "skipped" | "error";
  summary: string;
  artifacts: unknown[];
  actions: SkillAction[];
  citations: { url: string; title: string; quote: string }[];
  clarifyQuestion?: string;
}

export interface EmailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  risk: "normal" | "new_recipient";
}

export interface ResearchResult {
  query: string;
  answer: string;
  sources: { url: string; title: string; fetchedAt: string; quotes: string[] }[];
  unresolved?: boolean;
}

// ── Feature 19 — Proactive Scheduling & Triggers ─────────────────────────────

export type TriggerKind = "cron" | "event" | "condition";
export type TriggerStatus =
  | "scheduled"
  | "running"
  | "awaiting-approval"
  | "cooling-down"
  | "disabled";

export interface Trigger {
  id: string;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  cron?: { expr: string; timezone: string; oneShot?: boolean };
  event?: { topic: string; filter?: Record<string, unknown> };
  condition?: {
    metric: string;
    predicate: string;
    pollEverySec: number;
    debounceSec: number;
    cooldownSec: number;
  };
  action: { job: string } | { agentGoal: string };
  tags: string[];
  catchUp: "run-once" | "skip" | "run-all";
  status: TriggerStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerContext {
  trigger: Trigger;
  episodic: EpisodicState;
  inputs: Record<string, unknown>;
  firedAt: string;
  firedBy: "cron" | "event" | "condition" | "catch-up" | "manual";
}

export interface ScheduledJob {
  name: string;
  description: string;
  handler: (ctx: TriggerContext) => Promise<JobResult>;
  needsModel: "none" | "local" | "hf";
  maxDurationSec: number;
  singleton: boolean;
}

export interface JobResult {
  status: "done" | "partial" | "failed";
  summary: string;
  episodicUpdate?: Partial<EpisodicState>;
  error?: { code: string; message: string };
}

export interface TriggerRun {
  id: string;
  triggerId: string;
  firedAt: string;
  firedBy: "cron" | "event" | "condition" | "catch-up" | "manual";
  status: "running" | "done" | "failed" | "awaiting-approval";
  ranAs: { job: string } | { agentRunId: string };
  contextSummary: string;
  result?: unknown;
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt?: string;
  scheduledFor?: string;
}

export interface EpisodicState {
  triggerId: string;
  lastFiredAt?: string;
  lastDecision?: string;
  openFollowUps: { id: string; text: string; sinceRunId: string }[];
  conditionState?: {
    lastValue?: number;
    crossedAt?: string;
    cooldownUntil?: string;
  };
  runHistoryRefs: string[];
  updatedAt: string;
}

// ── Injected interfaces (provided at startup, never imported from a model dep) ─

/**
 * LLM client — injected; HuggingFace in prod, FakeLlm in tests.
 * tools? is a list of tool specs the model may call; if present, the model
 * should emit a tool_call in its response (hermes-style function calling).
 */
export interface LlmClient {
  complete(opts: {
    system?: string;
    prompt: string;
    json?: boolean;
    tools?: ToolSpec[];
  }): Promise<string>;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>; // JSON Schema object
}

/**
 * Tool — a single MCP-style tool in the registry.
 * readOnly: if true, auto-allow without approval.
 */
export interface Tool {
  name: string;
  description: string;
  schema: import("zod").ZodTypeAny;
  readOnly: boolean;
  run(args: unknown): Promise<unknown>;
}

export type ToolRegistry = Map<string, Tool>;

/** Approval callback injected into the agent. Resolves when user decides. */
export type ApprovalSink = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

/** Clock — injectable for deterministic test control. */
export interface Clock {
  now(): number; // ms since epoch
  isoNow(): string;
}
