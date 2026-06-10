/**
 * Web research tools — read-only, no approval required.
 *
 * web_search — live Brave Search API (BRAVE_API_KEY in .env; free tier at
 *   https://api-dashboard.search.brave.com). Missing key degrades to a
 *   structured ok:false note, never a throw. fetchFn is injectable for tests.
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

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const SEARCH_TIMEOUT_MS = 10_000;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

/**
 * Build the live web_search tool. fetchFn is injectable for tests; the real
 * registry uses the global fetch. The API key is read from BRAVE_API_KEY at
 * call time so `.env` auto-load ordering doesn't matter.
 */
export function makeWebSearchTool(fetchFn: typeof fetch = fetch): Tool {
  return {
    name: "web_search",
    description:
      "Search the web for information. Returns search results with titles, URLs, and snippets.",
    schema: WebSearchSchema,
    readOnly: true,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = WebSearchSchema.parse(rawArgs);

      const apiKey = process.env["BRAVE_API_KEY"];
      if (!apiKey) {
        return {
          ok: false,
          query: args.query,
          results: [],
          error:
            "BRAVE_API_KEY not set. Get a free key at https://api-dashboard.search.brave.com and add it to .env.",
        };
      }

      const count = args.max_results ?? 5;
      const params = new URLSearchParams({ q: args.query, count: String(count) });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
      try {
        const response = await fetchFn(`${BRAVE_SEARCH_URL}?${params}`, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        });

        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return {
            ok: false,
            query: args.query,
            status: response.status,
            results: [],
            error: `Brave Search API error: HTTP ${response.status}`,
          };
        }

        const data = (await response.json()) as { web?: { results?: BraveWebResult[] } };
        const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.description ?? "",
        }));
        return { ok: true, query: args.query, results, count: results.length };
      } catch (err) {
        return {
          ok: false,
          query: args.query,
          results: [],
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

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
