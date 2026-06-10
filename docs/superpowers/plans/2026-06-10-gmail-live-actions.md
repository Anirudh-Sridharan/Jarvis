# Gmail Live Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `email_search`, `email_get`, `email_send` live and add `email_draft`, via Gmail REST in `@jarvis/integrations`, keeping approval gating untouched.

**Architecture:** New `gmailActions.ts` module (deterministic transport, DI deps), bound as `IntegrationsSystem.email.*` in `createIntegrations`; core email tools become factories over that binding; gmail OAuth scopes widened to readonly+send+compose.

**Tech Stack:** TypeScript ESM strict, vitest + FakeHttp/MemoryTokenStore, Gmail REST v1.

**Spec:** `docs/superpowers/specs/2026-06-10-gmail-live-actions-design.md`

**Note:** user has waived plan-review and interim approvals; execute straight through with atomic commits on main. Per-task TDD: write test → see fail → implement → pass → commit.

---

### Task 1: `gmailActions.ts` — send + draft + RFC 2822 builder

**Files:**
- Create: `services/integrations/src/connectors/gmailActions.ts`
- Create: `services/integrations/test/gmailActions.test.ts`
- Modify: `services/integrations/src/index.ts` (bind `email`, export module)
- Modify: `services/integrations/src/framework/providers.ts` (scopes)

Steps: failing tests for `sendEmail` (raw decodes to To/Cc/Subject/body CRLF message; threadId passthrough; result ids; 429/500 retryable, 403 terminal; RFC 2047 subject for non-ASCII) and `createEmailDraft` (drafts URL, draftId result) → implement module + `buildRfc2822` + `mapGmailError` → bind `email.send/createDraft` in index.ts (search/getThread bound in Task 2 same commit boundary applies: bind all four in Task 1 to keep index.ts edited once; the two read fns may be stubs that throw until Task 2 — NO: bind only send/createDraft in Task 1, add search/getThread bindings in Task 2) → scopes to `["gmail.readonly","gmail.send","gmail.compose"]` full URLs → run suite → commit.

### Task 2: `gmailActions.ts` — search + getThread

Failing tests: search builds `q`+`maxResults`, bearer auth, per-hit metadata fetch, tolerates a metadata 404 (skips hit), list non-200 throws; getThread decodes nested multipart text/plain (base64url), missing plain part → empty body, non-200 throws. Implement; bind `email.search/getThread` in index.ts; full integrations suite; commit.

### Task 3: core email tool factories + e2e

**Files:**
- Modify: `services/core/src/agent/tools/emailTools.ts` (consts → factories, add `email_draft`)
- Modify: `services/core/src/agent/tools/index.ts` (use factories, widen Pick, doc comment)
- Modify: `services/core/src/agent/agentSystem.ts` (widen Pick to include "email")
- Modify: `services/core/test/agent-integration.test.ts` (e2e: approved email_send → FakeHttp POST /messages/send; email_draft runs without approval request)

Failing core e2e test → rewrite tools → build integrations+core, full core suite → commit.

### Task 4: docs

CLAUDE.md: email tools live (re-consent gmail), web-search remains the stubbed seam. Final verification sweep both packages. Commit.
