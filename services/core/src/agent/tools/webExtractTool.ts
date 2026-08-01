/**
 * web_extract — read-only agent tool, no approval required.
 *
 * Turns a URL into clean, LLM-ready markdown via Firecrawl's `/v2/scrape`
 * (renders JavaScript, strips nav/ads/boilerplate). Preferred way to read the
 * content of a page — `web_fetch` (webResearchTools.ts) is the raw/no-key
 * fallback. Missing FIRECRAWL_API_KEY degrades to a structured ok:false note,
 * never a throw, mirroring web_search's Brave degradation. fetchFn is
 * injectable for tests.
 *
 * Its output taints the run UNCONDITIONALLY via returnsExternalContent:true
 * (same as the six browser tools) — a page it reads escalates any later
 * side-effecting action through the approval gate, independent of whether the
 * injection scanner's patterns match. reactLoop.ts already scans every tool's
 * output unconditionally, so this tool does not call the scanner itself.
 */

import { z } from "zod";
import type { Tool } from "@jarvis/agent";
import { registerToolMeta } from "@jarvis/agent";

/** Hard cap on markdown returned to the loop — a hostile or pathological page
 * cannot flood the observation checkpointer. Matches webResearchTools.ts's
 * MAX_FETCH_BYTES (full-page prose, not an accessibility tree). */
export const MAX_EXTRACT_BYTES = 50_000;

/** Hard cap on bytes pulled off the wire — stop streaming past this, never
 * buffer an arbitrarily large (or slow-loris) body before slicing. Mirrors
 * webResearchTools.ts's MAX_READ_BYTES; comfortably above the expected
 * Firecrawl JSON envelope (~50 KB markdown + metadata). A response capped
 * mid-JSON fails the parse and degrades to a structured ok:false. */
export const MAX_EXTRACT_READ_BYTES = 256 * 1024;

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

/** AbortController backstop for a hung connection. Must stay strictly above
 * FIRECRAWL_SCRAPE_TIMEOUT_MS so Firecrawl's own graceful timeout response
 * wins the normal race. */
const EXTRACT_TIMEOUT_MS = 40_000;

/** Sent as the request body's `timeout` field (ms). Firecrawl times out the
 * scrape itself and returns a structured error before our AbortController
 * would ever fire. */
const FIRECRAWL_SCRAPE_TIMEOUT_MS = 30_000;

const WebExtractSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "only http(s) URLs are allowed")
    .describe("Absolute http(s) URL of the page to extract"),
  only_main_content: z
    .boolean()
    .optional()
    .default(true)
    .describe("Strip navigation, ads, and other boilerplate; keep only the main content"),
});

interface FirecrawlMetadata {
  title?: string;
  sourceURL?: string;
  url?: string;
  statusCode?: number;
  contentType?: string;
  creditsUsed?: number;
  cacheState?: string;
}

interface FirecrawlScrapeBody {
  success?: boolean;
  code?: string;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: FirecrawlMetadata;
  };
}

/** Stream-read the body up to MAX_EXTRACT_READ_BYTES, then stop — same reader
 * loop as webResearchTools.ts's web_fetch. The AbortController bounds *time*;
 * this bounds *bytes* (plenty of bytes fit in 40 s). */
async function readBodyCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytesRead >= MAX_EXTRACT_READ_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return text;
}

/** Read + JSON-parse a response body defensively — a non-JSON body (or one
 * that fails to read at all) must never throw a SyntaxError into the loop. */
async function readJsonSafe(response: Response): Promise<FirecrawlScrapeBody | null> {
  try {
    const text = await readBodyCapped(response);
    return JSON.parse(text) as FirecrawlScrapeBody;
  } catch {
    return null;
  }
}

function capMarkdown(markdown: string): { markdown: string; truncated: boolean } {
  if (markdown.length <= MAX_EXTRACT_BYTES) return { markdown, truncated: false };
  return { markdown: markdown.slice(0, MAX_EXTRACT_BYTES) + "\n... [truncated]", truncated: true };
}

/**
 * Build the live web_extract tool. fetchFn is injectable for tests; the real
 * registry uses the global fetch. The API key is read from
 * FIRECRAWL_API_KEY at call time (inside run()) so `.env` auto-load ordering
 * doesn't matter and the key is never captured at module/factory load.
 */
export function makeWebExtractTool(fetchFn: typeof fetch = fetch): Tool {
  registerToolMeta("web_extract", { sideEffects: "read_only", reversible: true });

  return {
    name: "web_extract",
    description:
      "Extract the readable content of a web page as clean markdown. Renders " +
      "JavaScript and strips boilerplate (nav, ads, cookie banners) via " +
      "Firecrawl. Preferred way to read the content of a page — use " +
      "web_fetch instead for raw response bodies (JSON, plain text) or when " +
      "FIRECRAWL_API_KEY is not configured.",
    schema: WebExtractSchema,
    readOnly: true,
    returnsExternalContent: true,

    async run(rawArgs: unknown): Promise<unknown> {
      const args = WebExtractSchema.parse(rawArgs);

      const apiKey = process.env["FIRECRAWL_API_KEY"];
      if (!apiKey) {
        return {
          ok: false,
          url: args.url,
          error: "FIRECRAWL_API_KEY not set. Get a key at https://www.firecrawl.dev and add it to .env.",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
      try {
        const response = await fetchFn(FIRECRAWL_SCRAPE_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            // Always send the key even though a live probe found /v2/scrape
            // answering anonymously — that behaviour is undocumented and
            // must not be depended on.
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            url: args.url,
            formats: ["markdown"],
            onlyMainContent: args.only_main_content,
            timeout: FIRECRAWL_SCRAPE_TIMEOUT_MS,
          }),
        });

        const body = await readJsonSafe(response);

        if (!response.ok) {
          return {
            ok: false,
            url: args.url,
            status: response.status,
            ...(body?.code ? { code: body.code } : {}),
            error: body?.error ?? `HTTP ${response.status}`,
          };
        }

        if (!body || body.success !== true) {
          return {
            ok: false,
            url: args.url,
            status: response.status,
            ...(body?.code ? { code: body.code } : {}),
            error: body?.error ?? `HTTP ${response.status}`,
          };
        }

        const rawMarkdown = body.data?.markdown ?? "";
        const { markdown, truncated } = capMarkdown(rawMarkdown);
        const metadata = body.data?.metadata ?? {};

        return {
          ok: true,
          url: args.url,
          markdown,
          truncated,
          title: metadata.title,
          statusCode: metadata.statusCode ?? response.status,
          creditsUsed: metadata.creditsUsed,
        };
      } catch (err) {
        return {
          ok: false,
          url: args.url,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
