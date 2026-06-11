/**
 * Playwright MCP client (feature 18 — browser automation slice).
 *
 * Live dependency: spawns `npx @playwright/mcp@latest --headless --isolated`
 * over stdio via the official @modelcontextprotocol/sdk and exposes the one
 * method the tool layer needs. `--isolated` is load-bearing for safety: the
 * fresh browser profile carries no cookies/sessions, so the agent can never
 * act with the user's logged-in identity.
 *
 * Lifecycle: lazy connect on first call; an idle timer closes the subprocess
 * (Chromium is not kept warm on a 16GB fanless Air); the next call respawns.
 * Failures here THROW — the tool layer (browserTools.ts) catches and degrades
 * to a structured error so the agent run never crashes.
 *
 * Env: JARVIS_BROWSER_MCP=0 disables (checked at wiring, liveBootstrap);
 *      JARVIS_BROWSER_MCP_CMD overrides the spawn command (space-separated),
 *      e.g. "npx @playwright/mcp@0.0.41 --headless --isolated".
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── DI seam ───────────────────────────────────────────────────────────────────

export interface McpToolResult {
  /** Concatenated text content blocks from the MCP tool result. */
  text: string;
  isError: boolean;
}

/** The seam the browser tools depend on; tests inject a fake. */
export interface McpToolClient {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

// ── Live implementation ───────────────────────────────────────────────────────

const DEFAULT_CMD = "npx @playwright/mcp@latest --headless --isolated";
const IDLE_STOP_MS = 5 * 60 * 1000;

export class PlaywrightMcpProcess implements McpToolClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes tool calls — the browser session is single-threaded state. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly command: string = process.env["JARVIS_BROWSER_MCP_CMD"] ?? DEFAULT_CMD,
    private readonly idleStopMs: number = IDLE_STOP_MS,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const run = this.queue.then(async () => {
      const client = await this.ensureConnected();
      this.touchIdleTimer();
      const result = await client.callTool({ name, arguments: args });
      this.touchIdleTimer();
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { text, isError: result.isError === true };
    });
    // Keep the chain alive past failures so one error doesn't wedge the queue.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Close the subprocess (idle timeout or shutdown). Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.connecting = null;
    if (client) {
      try {
        await client.close();
      } catch {
        // already dead — nothing to do
      }
    }
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const [cmd, ...cmdArgs] = this.command.split(/\s+/).filter(Boolean);
        if (!cmd) throw new Error("empty JARVIS_BROWSER_MCP_CMD");
        const transport = new StdioClientTransport({ command: cmd, args: cmdArgs });
        const client = new Client({ name: "jarvis-core", version: "1.0.0" });
        await client.connect(transport);
        this.client = client;
        return client;
      })();
      // A failed connect must not poison future attempts.
      this.connecting.catch(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.idleStopMs);
    // Never keep the process alive just for the idle timer.
    this.idleTimer.unref?.();
  }
}
