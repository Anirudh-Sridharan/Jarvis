/**
 * Email tools — bridge @jarvis/agent Tool interface to @jarvis/integrations Gmail.
 *
 * email_search — read-only: search email threads
 * email_get    — read-only: get a thread's full content
 * email_send   — write: gated by approval (readOnly:false, riskClass:outward_comm)
 * email_draft  — write: auto-allowed (internal_write — a draft never leaves the account)
 *
 * All four call integrations.email.* — live Gmail REST bound to the injected
 * HttpClient/TokenStore. The approval gate fires in the agent ReAct loop
 * BEFORE tool.run(), so an executed email_send is always user-approved.
 * Connect with `npm run connect -- gmail` (readonly + send + compose scopes).
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";
import type { IntegrationsSystem } from "@jarvis/integrations";

type EmailSystem = Pick<IntegrationsSystem, "email">;

// ── email_search ──────────────────────────────────────────────────────────────

const EmailSearchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Gmail search query (e.g. 'from:alice subject:invoice')"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Maximum number of messages to return"),
});

export function makeEmailSearchTool(integrations: EmailSystem): Tool {
  return {
    name: "email_search",
    description:
      "Search Gmail using a query string. Returns matching messages with subject/from/date and their thread IDs.",
    schema: EmailSearchSchema,
    readOnly: true,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = EmailSearchSchema.parse(rawArgs);
      const hits = await integrations.email.search(args.query, args.max_results);
      return { hits, count: hits.length };
    },
  };
}

// ── email_get ─────────────────────────────────────────────────────────────────

const EmailGetSchema = z.object({
  thread_id: z.string().describe("Gmail thread ID to retrieve"),
});

export function makeEmailGetTool(integrations: EmailSystem): Tool {
  return {
    name: "email_get",
    description: "Get the full content of a Gmail thread by thread ID.",
    schema: EmailGetSchema,
    readOnly: true,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = EmailGetSchema.parse(rawArgs);
      return integrations.email.getThread(args.thread_id);
    },
  };
}

// ── shared send/draft schema ──────────────────────────────────────────────────

const EmailComposeSchema = z.object({
  to: z
    .array(z.string().email())
    .min(1)
    .describe("Recipient email addresses"),
  subject: z.string().min(1).describe("Email subject line"),
  body: z.string().min(1).describe("Plain-text email body"),
  cc: z
    .array(z.string().email())
    .optional()
    .describe("CC recipient email addresses"),
  thread_id: z
    .string()
    .optional()
    .describe("Gmail thread ID to reply into (omit for new email)"),
});

// ── email_send ────────────────────────────────────────────────────────────────

export function makeEmailSendTool(integrations: EmailSystem): Tool {
  // Register risk class so the policy engine gates it correctly
  registerToolMeta("email_send", {
    sideEffects: "outward_comm",
    reversible: false,
  });

  return {
    name: "email_send",
    description:
      "Send an email via Gmail. Requires approval (outward_comm write operation). " +
      "Prefer email_draft when the user has not explicitly asked to send.",
    schema: EmailComposeSchema,
    readOnly: false, // triggers approval gate in agent loop

    async run(rawArgs: unknown): Promise<unknown> {
      const args = EmailComposeSchema.parse(rawArgs);
      return integrations.email.send({
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        body: args.body,
        threadId: args.thread_id,
      });
    },
  };
}

// ── email_draft ───────────────────────────────────────────────────────────────

export function makeEmailDraftTool(integrations: EmailSystem): Tool {
  // A draft never leaves the account — internal_write auto-allows (like todo_add)
  registerToolMeta("email_draft", {
    sideEffects: "internal_write",
    reversible: true,
  });

  return {
    name: "email_draft",
    description:
      "Create a Gmail draft (not sent). Safe default for 'draft a reply' tasks; the user sends it themselves or asks to send later.",
    schema: EmailComposeSchema,
    readOnly: false,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = EmailComposeSchema.parse(rawArgs);
      return integrations.email.createDraft({
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        body: args.body,
        threadId: args.thread_id,
      });
    },
  };
}
