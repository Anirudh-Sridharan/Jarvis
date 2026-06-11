# Browser automation via Playwright MCP

**Date:** 2026-06-11
**Status:** Approved (user pre-authorized build)
**Spec of record:** `features/18-task-automation-and-skills.md` (web.research / browser rows) + `features/17-action-approval-and-safety-gate.md` decision table.

## Context

Feature 18 ships web research via `web_search` + `web_fetch` (both live). The
spec's remaining browser slice — "Playwright MCP (`navigate`, `extract`) …
for tasks requiring interaction (click-through, pagination, JS-gated
content)" — is the marked MCP seam. This project closes it. The Python
`browser-use` LLM-driven path stays out of scope (spec's 20% path; revisit
only if the deterministic path proves insufficient).

## Decisions

1. **MCP client: official `@modelcontextprotocol/sdk`** (installed in
   `@jarvis/core`). The feature-18 spec's own sample uses an MCP client
   library; the SDK handles protocol-version negotiation, which is the part
   most likely to drift. Live-only dependency — tests never touch it (DI).

2. **Server: `npx @playwright/mcp@0.0.76 --headless --isolated`** (pinned —
   the tool arg schemas drift across versions; the `ref`→`target` rename was
   caught by review against the live server), spawned
   lazily on first browser-tool call. `--isolated` is load-bearing for
   safety: a fresh browser profile carries no cookies/sessions/credentials,
   so the agent can never act with the user's logged-in identity. The
   subprocess auto-stops after ~5 min idle (16GB fanless Air — Chromium is
   not kept warm). `JARVIS_BROWSER_MCP=0` disables; `JARVIS_BROWSER_MCP_CMD`
   overrides the spawn command (e.g. to pin a version).

3. **Curated tool surface, not raw passthrough** (spec: "never expose raw
   destructive tools directly"):

   | Agent tool | Playwright MCP tool | readOnly | Risk class |
   |---|---|---|---|
   | `browser_navigate` | `browser_navigate` | true | read_only |
   | `browser_snapshot` | `browser_snapshot` | true | read_only |
   | `browser_go_back` | `browser_navigate_back` | true | read_only |
   | `browser_click` | `browser_click` | false | **browser_action** |
   | `browser_type` | `browser_type` | false | **browser_action** |
   | `browser_press_key` | `browser_press_key` | false | **browser_action** |

   Not exposed in v1: evaluate/JS execution (code_exec-adjacent), file
   upload, downloads, tab management, screenshots (the local chat model is
   text-only; the accessibility snapshot is the agent's "eyes").

4. **Safety posture follows the LOCKED feature-17 table — strengthened.**
   All six tools are `returnsExternalContent`: page content taints the run
   UNCONDITIONALLY (not only when the injection scanner pattern-matches), so
   after any browser read, later side-effecting actions escalate and
   always-allow grants stop applying. The feature-17 "sandbox + egress
   allow-list" row is satisfied partially: `--isolated` covers identity;
   egress restriction is available via `JARVIS_BROWSER_ALLOWED_ORIGINS` /
   `JARVIS_BROWSER_BLOCKED_ORIGINS` (passed through to the server) but
   defaults to open — parity with the pre-existing `web_fetch` envelope on a
   single-user box. This is a documented, accepted risk.

   `browser_action → require_approval (always)` already exists in
   `DECISION_TABLE`. Interactions (click/type/press) are non-readOnly and
   gated through the existing approval flow; reads (navigate/snapshot/back)
   are readOnly and free, exactly like `web_fetch`. Navigation issues GETs
   from an isolated profile — same risk envelope as `web_fetch`. Snapshot
   output flows through the ReAct loop's existing injection scan, so
   prompt-injection in page content taints the run and escalates approval
   (already wired, feature 17).

5. **Degrade, never crash** (matches `web_search`-without-key): spawn or
   protocol failure returns a structured `{ error: "browser unavailable: …" }`
   tool result. Snapshot text is capped (~16k chars) before entering
   observations — page AX trees can be huge and observations are
   checkpointed.

## Architecture

```
@jarvis/agent (leaf; gains Tool.returnsExternalContent     services/core
               + unconditional taint in the ReAct loop)
  ReAct loop ── approval gate ──┐   ┌── agent/tools/browserTools.ts
  ToolRegistry (injected) ◄─────┴───┤     makeBrowserTools(client): Tool[]
                                    │     zod schemas + registerToolMeta
                                    └── mcp/playwrightMcp.ts
                                          McpToolClient (interface, faked in tests)
                                          PlaywrightMcpProcess (live impl, SDK,
                                            lazy spawn + idle stop)
```

- `McpToolClient` is the DI seam: `{ callTool(name, args): Promise<McpToolResult> }`,
  where `McpToolResult = { text: string; isError: boolean }`.
- `buildToolRegistry(integrations, browser?)` appends the six tools when a
  client is provided; absent in tests unless a fake is passed.
- `agentSystem.ts`/`liveBootstrap` construct the live client when not under
  vitest and not disabled, mirroring the existing live-deps pattern.

## Testing (fake-driven, no network/process)

- Tool arg validation (zod), result mapping, snapshot truncation cap.
- Degrade path: client throwing ⇒ structured error result, run continues.
- readOnly flags + registered risk metadata (`getToolMeta("browser_click").sideEffects === "browser_action"`).
- Registry inclusion with/without a client.
- Existing agent-package policy tests already cover `browser_action ⇒ require_approval`.

## Out of scope

- `browser-use` (Python LLM-driven browsing).
- Extending the `webResearch` skill to drive the browser tools (the ReAct
  agent can select them directly; skill integration is a later seam).
- Captcha/anti-bot circumvention (spec edge case 3: never auto-solve; the
  failure surfaces as a structured error).
