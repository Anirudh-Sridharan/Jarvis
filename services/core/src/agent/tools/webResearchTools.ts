/**
 * Web research tools — read-only, no approval required.
 *
 * web_search — stub that returns a clear "configure search provider" message.
 *   TODO(prod: wire a real search API/MCP) — e.g. Brave Search, SerpAPI, or an
 *   MCP tool provided by the search provider. The tool interface and schema are
 *   ready; only the HTTP call is missing.
 *
 * web_fetch  — real fetch via global fetch(). Returns the response text (capped
 *   at 50 KB to avoid context overflow). Falls back to error message on network
 *   failure.
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";

const MAX_FETCH_BYTES = 50_000;
/** Hard cap on bytes pulled off the wire — stop streaming past this, never
 * buffer a multi-GB (or slow-loris) body before slicing. */
const MAX_READ_BYTES = 256 * 1024;

// ── web_search ─────────────────────────────────────────────────────────────────

const WebSearchSchema = z.object({
  query: z.string().min(1).describe("Search query"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Maximum number of results to return"),
});

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the web for information. Returns search results with titles, URLs, and snippets.",
  schema: WebSearchSchema,
  readOnly: true,

  async run(rawArgs: unknown): Promise<unknown> {
    const args = WebSearchSchema.parse(rawArgs);
    // TODO(prod: wire a real search API/MCP)
    // Acceptable providers: Brave Search API, SerpAPI, Tavily, or a search MCP tool.
    // The interface is stable — swap the body below once credentials are available.
    return {
      query: args.query,
      results: [],
      note:
        "web_search is not yet configured. " +
        "TODO(prod: wire a real search API/MCP — e.g. Brave Search, SerpAPI, or search MCP tool). " +
        `Query was: "${args.query}"`,
    };
  },
};

// ── web_fetch ─────────────────────────────────────────────────────────────────

const WebFetchSchema = z.object({
  url: z.string().url().describe("URL to fetch"),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .default(15_000)
    .describe("Fetch timeout in milliseconds"),
});

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch the contents of a web page. Returns the response text (up to 50 KB).",
  schema: WebFetchSchema,
  readOnly: true,

  async run(rawArgs: unknown): Promise<unknown> {
    const args = WebFetchSchema.parse(rawArgs);

    // The timeout covers the WHOLE operation — headers AND body read. A server
    // that returns headers fast then trickles the body (slow-loris) must not
    // hold the agent loop hostage.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeout_ms ?? 15_000);

    try {
      const response = await fetch(args.url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Jarvis/0.1 (personal AI assistant; read-only fetch)",
          Accept: "text/html,text/plain,application/json",
        },
      });

      if (!response.ok) {
        // Don't read the error body; release the connection.
        await response.body?.cancel().catch(() => {});
        return {
          ok: false,
          url: args.url,
          status: response.status,
          error: `HTTP ${response.status} ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";

      // Stream-read the body up to MAX_READ_BYTES, then stop — never buffer an
      // arbitrarily large body before slicing.
      const decoder = new TextDecoder();
      let text = "";
      let bytesRead = 0;
      let capped = false;
      const body = response.body;
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.byteLength;
          text += decoder.decode(value, { stream: true });
          if (bytesRead >= MAX_READ_BYTES) {
            capped = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
        text += decoder.decode();
      }

      const truncated = capped || text.length > MAX_FETCH_BYTES;
      const content = truncated
        ? text.slice(0, MAX_FETCH_BYTES) + "\n... [truncated]"
        : text;

      return {
        ok: true,
        url: args.url,
        status: response.status,
        contentType,
        content,
        truncated,
        lengthBytes: bytesRead,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        url: args.url,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
