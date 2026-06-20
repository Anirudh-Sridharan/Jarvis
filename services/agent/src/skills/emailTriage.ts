/**
 * Email triage skill (feature 18).
 *
 * Pipeline (tool names match core's live registry):
 *   1. READ: email_search → email_get (no approval, read-only)
 *   2. SYNTHESIZE: AI categorize + draft reply (enum-guarded)
 *   3. SEND: needs_reply drafts go to email_send — gated by approval
 *   4. On denial, the reply is staged as a Gmail draft via email_draft
 *      (internal_write, not sent) so the user can review and send manually.
 *
 * TODO(labels): Gmail labeling is not wired in core yet; the label step was
 * removed until an email_label tool exists.
 */

import { z } from "zod";
import type { Skill, SkillCtx } from "./registry.js";
import { ToolApprovalDeniedError } from "./registry.js";
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
  allowedTools: ["email_search", "email_get", "email_draft", "email_send"],
  outward: false,
  approvalPolicy: "conditional",

  async run(rawArgs: unknown, ctx: SkillCtx): Promise<SkillResult> {
    const { window, maxThreads } = TriageArgs.parse(rawArgs);

    // ── 1. READ ──────────────────────────────────────────────────────────────
    let ids: string[];
    try {
      const res = (await ctx.tool("email_search", {
        query: `in:inbox ${window} -category:promotions`,
        max_results: maxThreads,
      })) as { hits?: Array<{ threadId: string }> };
      ids = [...new Set((res.hits ?? []).map((h) => h.threadId))].slice(0, maxThreads);
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

    const threads: unknown[] = [];
    for (const id of ids) {
      try {
        const thread = await ctx.tool("email_get", { thread_id: id });
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
      artifacts.push({
        threadId: t.threadId,
        category: t.category,
        summary: t.summary,
        draft: t.draft,
      });

      // ── 3. SEND (if needs_reply) — ctx.tool gates non-readOnly tools
      //       structurally (policy + approval), so the send is paused for the
      //       user before execution. Provenance marks the draft as derived
      //       from external content (the thread) for taint escalation.
      if (t.category === "needs_reply" && t.draft) {
        try {
          await ctx.tool(
            "email_send",
            {
              to: t.draft.to,
              subject: t.draft.subject,
              body: t.draft.body,
              thread_id: t.draft.threadId,
            },
            {
              reasoning: `Reply to thread ${t.threadId}: ${t.summary}`,
              provenance: {
                derivedFromExternal: true,
                sources: [t.threadId],
              },
            },
          );
          actions.push({
            type: "email.send",
            status: "done",
            target: t.draft.to.join(","),
          });
        } catch (err) {
          if (err instanceof ToolApprovalDeniedError) {
            // ── 4. Stage as a Gmail draft instead (internal_write, not sent)
            try {
              await ctx.tool("email_draft", {
                to: t.draft.to,
                subject: t.draft.subject,
                body: t.draft.body,
                thread_id: t.draft.threadId,
              });
            } catch {
              // draft staging is best-effort
            }
            actions.push({
              type: "email.send",
              status: "skipped",
              target: t.draft.to.join(","),
              reason:
                (err.outcome === "blocked"
                  ? "blocked: " + err.reasons.join("; ")
                  : err.outcome) + " (draft staged)",
            });
          } else {
            actions.push({
              type: "email.send",
              status: "failed",
              target: t.draft.to.join(","),
              reason: err instanceof Error ? err.message : String(err),
            });
          }
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

    // Only needs_reply threads carry a draft; everything else is informational.
    const draft =
      category === "needs_reply" && parsed.draft
        ? buildDraft(parsed.draft, threadId, ctx)
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

/**
 * Coerce the model's loosely-typed draft into an EmailDraft. The recipient
 * list is normalized to an array (the model sometimes emits a bare string),
 * and the draft is risk-tagged "new_recipient" unless the first recipient is
 * a known contact — which downstream feeds the policy's new-recipient rule.
 */
function buildDraft(
  rawDraft: { to: string[]; subject: string; body: string },
  threadId: string,
  ctx: SkillCtx,
): EmailDraft {
  const to = Array.isArray(rawDraft.to) ? rawDraft.to : [String(rawDraft.to)];
  return {
    to,
    subject: String(rawDraft.subject ?? ""),
    body: String(rawDraft.body ?? ""),
    threadId,
    risk: ctx.isKnownContact(to[0] ?? "") ? "normal" : "new_recipient",
  };
}
