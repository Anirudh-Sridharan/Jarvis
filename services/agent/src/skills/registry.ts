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
 */

import type { LlmClient, ToolRegistry, ApprovalSink, Clock } from "../types.js";
import type { SkillResult } from "../types.js";
import type { ApprovalService } from "../safety/approval.js";
import type { AuditLog } from "../safety/audit.js";

// ── SkillContext: injected into every skill run ───────────────────────────────

export interface SkillCtx {
  llm: LlmClient;
  tools: ToolRegistry;
  approvalService: ApprovalService;
  auditLog: AuditLog;
  clock: Clock;
  /** Run a tool by name, validated. Throws on tool not found. */
  tool(name: string, args: unknown): Promise<unknown>;
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
   */
  makeCtx(
    tools: ToolRegistry,
    llm: LlmClient,
    approvalService: ApprovalService,
    auditLog: AuditLog,
    clock: Clock,
  ): SkillCtx {
    return {
      llm,
      tools,
      approvalService,
      auditLog,
      clock,
      async tool(name: string, args: unknown): Promise<unknown> {
        const t = tools.get(name);
        if (!t) throw new Error(`Tool not found: ${name}`);
        return t.run(args);
      },
      isKnownContact(email: string): boolean {
        // Stub: in production, query feature 5 memory / contacts store
        return false;
      },
    };
  }
}
