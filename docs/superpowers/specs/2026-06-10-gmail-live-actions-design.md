# Gmail Live Actions (search / read / send / draft) — Design

**Date:** 2026-06-10
**Status:** Approved (full scope: search+read+send+draft)
**Closes:** `TODO(prod: wire Google Workspace MCP / Gmail OAuth)` in `services/core/src/agent/tools/emailTools.ts`
**Specs:** `features/18-task-automation-and-skills.md` (email triage/drafting), `features/17-action-approval-and-safety-gate.md`, `features/13-work-and-productivity-metrics.md` (existing read sync)

## Problem

All four email agent tools (`email_search`, `email_get`, `email_send`, plus a
missing draft capability) throw "Gmail not connected". The approval gating is
already correct (`email_send` is `outward_comm`, never auto-approved). The
Gmail OAuth loopback consent flow already works (`npm run connect -- gmail`)
but only with `gmail.readonly`.

MCP (option A in the stub's TODO) is not viable: the Claude-session Gmail MCP
tools don't exist in Jarvis's runtime. Option B — Gmail REST in
`@jarvis/integrations` over the existing OAuth/Keychain plumbing — matches the
calendar write path that just landed.

## Design

### 1. `services/integrations/src/connectors/gmailActions.ts` (new file)

Separate file from `gmail.ts` (metrics sync) — one responsibility each. The
sync connector's privacy stance ("never STORES email bodies") is preserved:
actions return bodies to the caller transiently; nothing is persisted.

Deps + types:

```ts
export interface GmailDeps { http: HttpClient; tokenStore: TokenStore; }
export interface EmailSearchHit { messageId: string; threadId: string; subject: string; from: string; date: string; }
export interface EmailMessage { id: string; threadId: string; from: string; to: string; subject: string; date: string; body: string; }
export interface EmailThread { id: string; messages: EmailMessage[]; }
export interface EmailSendRequest { to: string[]; cc?: string[]; subject: string; body: string; threadId?: string; }
export interface EmailSendResult {
  ok: boolean;
  messageId?: string;
  threadId?: string;
  draftId?: string;
  error?: { code: number; reason: string; retryable: boolean };
}
```

Functions (all take `deps` last, auth via `getAccessToken("gmail", …)`):

- `searchEmail(query, maxResults, deps)` → `messages.list?q=…&maxResults=…`,
  then per-id `format=metadata&metadataHeaders=Subject,From,Date` (per-message
  misses tolerated, same as the sync connector). Returns `EmailSearchHit[]`.
  Non-200 on the list call throws (read tools throw; the ReAct loop turns tool
  errors into observations).
- `getEmailThread(threadId, deps)` → `threads/{id}?format=full`. Walks MIME
  parts recursively for the first `text/plain` body, base64url-decodes it.
  Returns `EmailThread`. Non-200 throws.
- `sendEmail(req, deps)` → builds an RFC 2822 message (CRLF, MIME 1.0,
  `text/plain; charset="UTF-8"`, RFC 2047 base64-encoded Subject when
  non-ASCII), base64url-encodes it, `POST messages/send { raw, threadId? }`.
  Returns `EmailSendResult` (429/5xx → `retryable:true`, like calendar).
- `createEmailDraft(req, deps)` → same message build,
  `POST drafts { message: { raw, threadId? } }`. Returns `EmailSendResult`
  with `draftId`.

### 2. Binding in `createIntegrations`

`IntegrationsSystem` gains:

```ts
email: {
  search: (query: string, maxResults?: number) => Promise<EmailSearchHit[]>;
  getThread: (threadId: string) => Promise<EmailThread>;
  send: (req: EmailSendRequest) => Promise<EmailSendResult>;
  createDraft: (req: EmailSendRequest) => Promise<EmailSendResult>;
};
```

bound over `config.http`/`config.tokenStore` — same pattern as
`calendar.executeWrite`.

### 3. Scopes

`gmail` provider scopes become `gmail.readonly` + `gmail.send` +
`gmail.compose` (drafts). Existing users re-run `npm run connect -- gmail`.

### 4. Core email tools become factories

`emailTools.ts` consts → `makeEmailSearchTool/makeEmailGetTool/
makeEmailSendTool/makeEmailDraftTool(integrations: Pick<IntegrationsSystem, "email">)`.

- `email_send` keeps `outward_comm`, `reversible:false` — approval always.
- NEW `email_draft` tool: `sideEffects: "internal_write"`, `reversible:true`
  (a draft never leaves the account — same auto-allow class as `todo_add`),
  `readOnly:false`. This gives the agent a safe default for "draft a reply"
  tasks per feature 18 without burning an approval round-trip.
- `email_search`/`email_get` stay `readOnly:true`.

`buildToolRegistry` and `getAgentSystem` widen their `Pick` to include
`"email"`. The live bootstrap already passes the full system.

### 5. Tests (fakes only, no network)

- Integrations `test/gmailActions.test.ts`: search query/auth/metadata + miss
  tolerance; thread body extraction from nested multipart; send raw decodes
  back to expected headers/body + threadId passthrough; draft create; error
  mapping 429/5xx retryable vs 4xx terminal; RFC 2047 subject encoding.
- Core `agent-integration.test.ts`: approved `email_send` run drives the
  FakeHttp POST to `/messages/send` (mirror of the calendar e2e test);
  `email_draft` auto-allows without approval.

## Out of scope

- Web research live path (next task).
- HTML email bodies / attachments (text/plain only, `// TODO(scale)`).
- References/In-Reply-To header chaining for replies — `threadId` is passed to
  the API which threads in Gmail's UI; full RFC threading is a marked TODO.
