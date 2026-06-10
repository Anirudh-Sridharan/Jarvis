/**
 * Skill registry (feature 18).
 *
 * A Skill is a registered, reusable capability that the agent can invoke.
 * Skills wrap MCP tools (or local stores) behind a typed, validated interface.
 *
 * Registration table (from spec):
 *   email.triage   → read + draft (no approval)
 *   email.send     → outward (approval always)
 *   calendar.manage→ write = approval; read = no
 *   web.research   → read-only (no approval)
 *   reminders.todo → local store (no approval)
 *
 * SAFETY: ctx.tool() is the ONLY way a skill executes a tool, and it gates
 * STRUCTURALLY — zod schema validation, the skill's allowedTools list, and the
 * approval/policy path for every non-readOnly tool. Skills cannot opt out.
 */

import { randomUUID } from "node:crypto";
import type {
  LlmClient,
  ToolRegistry,
  Clock,
  ProposedAction,
} from "../types.js";
import type { SkillResult } from "../types.js";
import type { ApprovalService } from "../safety/approval.js";
import type { AuditLog } from "../safety/audit.js";

/** How long ctx.tool waits for a human decision in skill context. */
const SKILL_APPROVAL_TIMEOUT_MS = 5000;

// ── Errors thrown by the structural gate ─────────────────────────────────────

/** Thrown when a skill calls a tool not in its allowedTools list. */
export class ToolNotAllowedError extends Error {
  constructor(toolName: string, skillId: string) {
    super(`Tool "${toolName}" is not in the allowedTools of skill "${skillId}"`);
    this.name = "ToolNotAllowedError";
  }
}

/** Thrown when the approval gate blocks/denies a non-readOnly tool call. */
export class ToolApprovalDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly outcome: "blocked" | "rejected" | "expired" | "timeout",
    public readonly reasons: string[] = [],
  ) {
    super(
      `Tool "${tool}" was not approved: ${outcome}` +
        (reasons.length > 0 ? ` (${reasons.join("; ")})` : ""),
    );
    this.name = "ToolApprovalDeniedError";
  }
}

// ── SkillContext: injected into every skill run ───────────────────────────────

export interface ToolCallOpts {
  /** Why the skill is invoking this tool (goes into the ProposedAction). */
  reasoning?: string;
  /** Provenance for taint escalation — set derivedFromExternal when the args
   *  were derived from untrusted external content (email bodies, web pages). */
  provenance?: Partial<ProposedAction["provenance"]>;
}

export interface SkillCtx {
  llm: LlmClient;
  tools: ToolRegistry;
  approvalService: ApprovalService;
  auditLog: AuditLog;
  clock: Clock;
  /**
   * Run a tool by name. Structurally enforced:
   *   1. tool must be in the skill's allowedTools,
   *   2. args are zod-validated against the tool's schema,
   *   3. non-readOnly tools go through the policy + approval gate.
   * Throws ToolNotAllowedError / ZodError / ToolApprovalDeniedError.
   */
  tool(name: string, args: unknown, opts?: ToolCallOpts): Promise<unknown>;
  /** Check if an email address is a known contact. */
  isKnownContact(email: string): boolean;
}

// ── Skill interface ──────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Tools this skill is allowed to use */
  allowedTools: string[];
  /** Does this skill cause outward side effects? */
  outward: boolean;
  /** Approval policy */
  approvalPolicy: "never" | "always" | "conditional";
  run(args: unknown, ctx: SkillCtx): Promise<SkillResult>;
}

// ── SkillRegistry ─────────────────────────────────────────────────────────────

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Create a SkillCtx from injected dependencies.
   * Pass the skill being run so ctx.tool can enforce its allowedTools list.
   */
  makeCtx(
    tools: ToolRegistry,
    llm: LlmClient,
    approvalService: ApprovalService,
    auditLog: AuditLog,
    clock: Clock,
    forSkill: Pick<Skill, "id" | "allowedTools">,
  ): SkillCtx {
    return {
      llm,
      tools,
      approvalService,
      auditLog,
      clock,
      async tool(
        name: string,
        args: unknown,
        opts?: ToolCallOpts,
      ): Promise<unknown> {
        // 1. allowedTools enforcement
        if (!forSkill.allowedTools.includes(name)) {
          throw new ToolNotAllowedError(name, forSkill.id);
        }

        const t = tools.get(name);
        if (!t) throw new Error(`Tool not found: ${name}`);

        // 2. Schema validation (throws ZodError on mismatch)
        const validated = t.schema.parse(args);

        // 3. Approval gate for any non-readOnly tool — structural, skills
        //    cannot bypass it.
        if (!t.readOnly) {
          const actionId = randomUUID();
          const action: ProposedAction = {
            id: actionId,
            runId: forSkill.id,
            tool: name,
            args: (validated ?? {}) as Record<string, unknown>,
            reasoning:
              opts?.reasoning ??
              `Skill ${forSkill.id} invoked ${name}`,
            provenance: {
              derivedFromExternal: opts?.provenance?.derivedFromExternal ?? false,
              sources: opts?.provenance?.sources ?? [],
              injectionFlags: opts?.provenance?.injectionFlags ?? [],
            },
            proposedAt: clock.isoNow(),
          };

          const { decision } = await approvalService.evaluateAndMaybeRequest(
            action,
            auditLog,
            clock,
          );

          if (decision.outcome === "block") {
            throw new ToolApprovalDeniedError(name, "blocked", decision.reasons);
          }

          if (decision.outcome === "require_approval") {
            const approval = await approvalService.waitForDecision(
              actionId,
              clock,
              SKILL_APPROVAL_TIMEOUT_MS,
            );
            if (!approval || approval.status !== "approved") {
              const outcome =
                approval?.status === "rejected"
                  ? ("rejected" as const)
                  : approval?.status === "expired"
                    ? ("expired" as const)
                    : ("timeout" as const);
              throw new ToolApprovalDeniedError(name, outcome);
            }
          }
        }

        return t.run(validated);
      },
      isKnownContact(email: string): boolean {
        // Stub: in production, query feature 5 memory / contacts store
        return false;
      },
    };
  }
}
