/**
 * Email tools — bridge @jarvis/agent Tool interface to Gmail.
 *
 * email_search  — read-only: search email threads
 * email_get     — read-only: get a thread's full content
 * email_send    — write: gated by approval (readOnly:false, riskClass:outward_comm)
 *
 * STUB: Gmail requires OAuth not available in the local dev environment.
 * All live calls throw a friendly "Gmail not connected" error.
 * TODO(prod: wire Google Workspace MCP / Gmail OAuth)
 *   - Option A: use the mcp__claude_ai_Gmail__ MCP tools directly.
 *   - Option B: implement OAuth flow in @jarvis/integrations gmail connector
 *     and call integrations.connectors.get('gmail').sync(...).
 *
 * The tool schemas and approval gating are correctly wired — only the HTTP
 * calls are stubbed.
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";

// Register email_send risk class so the policy engine gates it correctly
registerToolMeta("email_send", {
  sideEffects: "outward_comm",
  reversible: false,
});

function gmailNotConnected(toolName: string): never {
  throw new Error(
    `[${toolName}] Gmail is not connected. ` +
      "TODO(prod: wire Google Workspace MCP / Gmail OAuth — " +
      "see services/core/src/agent/tools/emailTools.ts for options.)",
  );
}

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
    .describe("Maximum number of thread IDs to return"),
});

export const emailSearchTool: Tool = {
  name: "email_search",
  description:
    "Search Gmail threads using a query string. Returns matching thread IDs.",
  schema: EmailSearchSchema,
  readOnly: true,

  async run(rawArgs: unknown): Promise<unknown> {
    EmailSearchSchema.parse(rawArgs);
    // TODO(prod: wire Google Workspace MCP / Gmail OAuth)
    gmailNotConnected("email_search");
  },
};

// ── email_get ─────────────────────────────────────────────────────────────────

const EmailGetSchema = z.object({
  thread_id: z.string().describe("Gmail thread ID to retrieve"),
});

export const emailGetTool: Tool = {
  name: "email_get",
  description:
    "Get the full content of a Gmail thread by thread ID.",
  schema: EmailGetSchema,
  readOnly: true,

  async run(rawArgs: unknown): Promise<unknown> {
    EmailGetSchema.parse(rawArgs);
    // TODO(prod: wire Google Workspace MCP / Gmail OAuth)
    gmailNotConnected("email_get");
  },
};

// ── email_send ────────────────────────────────────────────────────────────────

const EmailSendSchema = z.object({
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

export const emailSendTool: Tool = {
  name: "email_send",
  description:
    "Send an email via Gmail. Requires approval (outward_comm write operation). " +
    "TODO(prod: wire Google Workspace MCP / Gmail OAuth).",
  schema: EmailSendSchema,
  readOnly: false, // triggers approval gate in agent loop

  async run(rawArgs: unknown): Promise<unknown> {
    EmailSendSchema.parse(rawArgs);
    // TODO(prod: wire Google Workspace MCP / Gmail OAuth)
    gmailNotConnected("email_send");
  },
};
