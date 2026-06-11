# Browser Automation via Playwright MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Executed inline by the author in the same session — tasks kept compact; the design spec (`docs/superpowers/specs/2026-06-11-browser-automation-mcp-design.md`) carries the full contract.

**Goal:** Six curated browser tools (navigate/snapshot/go_back free; click/type/press_key gated as `browser_action`) backed by a lazily-spawned `@playwright/mcp` subprocess, wired through the existing DI seams. `@jarvis/agent` unchanged.

### Task 1: failing tests — `services/core/test/browserTools.test.ts`
Fake `McpToolClient`; assert: zod arg validation rejects bad args before any MCP call; result mapping (text + isError); snapshot truncation at cap; degrade to structured error when client throws; readOnly flags per spec table; `getToolMeta("browser_click").sideEffects === "browser_action"` (and type/press_key); navigate/snapshot/go_back have `sideEffects: "read_only"`; `buildToolRegistry` includes the six tools only when a client is passed.

### Task 2: `services/core/src/mcp/playwrightMcp.ts`
- `export interface McpToolClient { callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> }`
- `export interface McpToolResult { text: string; isError: boolean }`
- `export class PlaywrightMcpProcess implements McpToolClient` — live impl over `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`:
  - lazy `ensureConnected()` on first call (spawn `npx @playwright/mcp@latest --headless --isolated`, or `JARVIS_BROWSER_MCP_CMD` split on spaces);
  - serializes calls; maps SDK result content (`content[].text` joined) + `isError`;
  - idle timer (5 min) closes the client/transport; next call respawns;
  - `stop()` for shutdown; failures throw (the tool layer catches and degrades).

### Task 3: `services/core/src/agent/tools/browserTools.ts`
`makeBrowserTools(client: McpToolClient): Tool[]` — six tools per the spec table, zod schemas:
- navigate `{ url: string.url() }`, snapshot `{}`, go_back `{}`
- click `{ element: string, ref: string }`, type `{ element, ref, text, submit?: boolean }`, press_key `{ key: string }`
Each `run`: call client, return `{ ok, text }` or `{ ok: false, error: "browser unavailable: …" }` on throw; snapshot/all text capped at 16_000 chars with a `[truncated]` marker. `registerToolMeta` for all six (read_only / browser_action, `reversible: false` for gated ones).

### Task 4: wiring
- `tools/index.ts`: `buildToolRegistry(integrations, browser?: McpToolClient | null)` appends browser tools when provided.
- `agentSystem.ts`: `getAgentSystem(gateway, integrations, memory?, browser?)` threads it through.
- `liveBootstrap.ts`: construct `PlaywrightMcpProcess` unless `JARVIS_BROWSER_MCP=0` (vitest path already returns early).

### Task 5: verification + docs
`npm test --workspace @jarvis/core` (and agent/memory untouched-sanity), dashboard typecheck unaffected. CLAUDE.md live-prereqs: one sentence on browser tools + the isolated-profile posture. Commits per task.
