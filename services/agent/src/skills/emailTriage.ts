/**
 * Email triage skill (feature 18).
 *
 * Pipeline:
 *   1. READ: search_threads → get_thread (no approval, read-only)
 *   2. SYNTHESIZE: AI categorize + draft reply (enum-guarded)
 *   3. LABEL: label_thread with Jarvis category (reversible, no approval)
 *   4. DRAFT: create_draft (not sent; no approval)
 *   5. If needs_reply + draft: submit to approval gate before sending
 *
 * The send step always requires approval (outward_comm).
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Skill, SkillCtx } from "./registry.js";
import type { SkillResult, SkillAction, EmailDraft } from "../types.js";

const CATEGORY_ENUM = ["needs_reply", "fyi", "newsletter", "spam"] as const;
type Category = (typeof CATEGORY_ENUM)[number];

const TriageArgs = z.object({
  window: z.string().optional().default("newer_than:1d"),
  maxThreads: z.number().int().min(1).max(50).optional().default(20),
});

interface TriagedThread {
  threadId: string;
  category: Category;
  summary: string;
  draft?: EmailDraft;
}

export const emailTriageSkill: Skill = {
  id: "email.triage",
  name: "Email Triage",
  description:
    "Summarize inbox, categorize threads, draft replies, request approval before sending.",
  allowedTools: [
    "search_threads",
    "get_thread",
    "label_thread",
    "create_draft",
    "send_email",
  ],
  outward: false,
  approvalPolicy: "conditional",

  async run(rawArgs: unknown, ctx: SkillCtx): Promise<SkillResult> {
    const { window, maxThreads } = TriageArgs.parse(rawArgs);

    // ── 1. READ ──────────────────────────────────────────────────────────────
    let threadIds: unknown[];
    try {
      threadIds = (await ctx.tool("search_threads", {
        q: `in:inbox ${window} -category:promotions`,
      })) as unknown[];
    } catch {
      return {
        skillId: "email.triage",
        status: "error",
        summary: "Failed to search inbox",
        artifacts: [],
        actions: [],
        citations: [],
      };
    }

    if (!Array.isArray(threadIds)) threadIds = [];
    const ids = (threadIds as string[]).slice(0, maxThreads);

    const threads: unknown[] = [];
    for (const id of ids) {
      try {
        const thread = await ctx.tool("get_thread", { id });
        threads.push(thread);
      } catch {
        // skip inaccessible threads
      }
    }

    if (threads.length === 0) {
      return {
        skillId: "email.triage",
        status: "ok",
        summary: "No threads found in inbox",
        artifacts: [],
        actions: [],
        citations: [],
      };
    }

    // ── 2. SYNTHESIZE (AI) ───────────────────────────────────────────────────
    const triaged = await categorizeAndDraft(ctx, threads, ids);

    // ── 3+4. LABEL + DRAFT ──────────────────────────────────────────────────
    const actions: SkillAction[] = [];
    const artifacts: unknown[] = [];

    for (const t of triaged) {
      // Label (reversible; no approval)
      try {
        await ctx.tool("label_thread", {
          id: t.threadId,
          label: `Jarvis/${t.category}`,
        });
      } catch {
        // non-fatal
      }

      artifacts.push({
        threadId: t.threadId,
        category: t.category,
        summary: t.summary,
        draft: t.draft,
      });

      // ── 5. APPROVAL + SEND (if needs_reply) ──────────────────────────────
      if (t.category === "needs_reply" && t.draft) {
        const actionId = randomUUID();
        const proposedAction = {
          id: actionId,
          runId: actionId,
          tool: "send_email",
          args: {
            to: t.draft.to,
            subject: t.draft.subject,
            body: t.draft.body,
            threadId: t.draft.threadId,
          },
          reasoning: `Reply to thread ${t.threadId}: ${t.summary}`,
          provenance: {
            derivedFromExternal: true,
            sources: [t.threadId],
            injectionFlags: [],
          },
          proposedAt: ctx.clock.isoNow(),
        };

        const { decision, requestId } =
          await ctx.approvalService.evaluateAndMaybeRequest(
            proposedAction,
            ctx.auditLog,
            ctx.clock,
          );

        if (decision.outcome === "block") {
          actions.push({
            type: "email.send",
            status: "skipped",
            target: t.draft.to.join(","),
            reason: "blocked: " + decision.reasons.join("; "),
          });
          continue;
        }

        if (decision.outcome === "require_approval" && requestId) {
          const approval = await ctx.approvalService.waitForDecision(
            actionId,
            ctx.clock,
            5000, // short timeout in skill context
          );

          if (!approval || approval.status !== "approved") {
            actions.push({
              type: "email.send",
              status: "skipped",
              target: t.draft.to.join(","),
              reason: approval?.status ?? "timeout",
            });
            continue;
          }
        }

        // Send
        try {
          await ctx.tool("send_email", {
            to: t.draft.to,
            subject: t.draft.subject,
            body: t.draft.body,
            threadId: t.draft.threadId,
          });
          actions.push({
            type: "email.send",
            status: "done",
            target: t.draft.to.join(","),
          });
        } catch (err) {
          actions.push({
            type: "email.send",
            status: "failed",
            target: t.draft.to.join(","),
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const sent = actions.filter((a) => a.status === "done").length;
    return {
      skillId: "email.triage",
      status: "ok",
      summary: `Triaged ${threads.length} threads; ${sent} replies sent.`,
      artifacts,
      actions,
      citations: [],
    };
  },
};

async function categorizeAndDraft(
  ctx: SkillCtx,
  threads: unknown[],
  ids: string[],
): Promise<TriagedThread[]> {
  const results: TriagedThread[] = [];

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const threadId = ids[i] ?? `thread-${i}`;

    const prompt =
      `Categorize this email thread and optionally draft a reply.\n` +
      `Thread: ${JSON.stringify(thread).slice(0, 1000)}\n\n` +
      `Respond with JSON: {"category": one of ${CATEGORY_ENUM.join("|")}, ` +
      `"summary": "one-line summary", "draft": {"to": ["..."], "subject": "...", "body": "..."} or null}\n` +
      `Only include draft when category is "needs_reply".`;

    let raw: string;
    try {
      raw = await ctx.llm.complete({ prompt, json: true });
    } catch {
      results.push({ threadId, category: "fyi", summary: "Could not analyze" });
      continue;
    }

    let parsed: {
      category: string;
      summary: string;
      draft?: { to: string[]; subject: string; body: string } | null;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      results.push({ threadId, category: "fyi", summary: raw.slice(0, 100) });
      continue;
    }

    // Validate category against enum
    const category = CATEGORY_ENUM.includes(parsed.category as Category)
      ? (parsed.category as Category)
      : "fyi";

    const draft: EmailDraft | undefined =
      category === "needs_reply" && parsed.draft
        ? {
            to: Array.isArray(parsed.draft.to)
              ? parsed.draft.to
              : [String(parsed.draft.to)],
            subject: String(parsed.draft.subject ?? ""),
            body: String(parsed.draft.body ?? ""),
            threadId,
            risk: ctx.isKnownContact(
              (Array.isArray(parsed.draft.to)
                ? (parsed.draft.to[0] ?? "")
                : String(parsed.draft.to)) ?? "",
            )
              ? "normal"
              : "new_recipient",
          }
        : undefined;

    results.push({
      threadId,
      category,
      summary: String(parsed.summary ?? ""),
      draft,
    });
  }

  return results;
}
