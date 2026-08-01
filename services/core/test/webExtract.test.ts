/**
 * web_extract tool tests — Firecrawl /v2/scrape client with injected fetchFn.
 * No network: fetchFn is stubbed; FIRECRAWL_API_KEY is controlled per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  makeWebExtractTool,
  MAX_EXTRACT_BYTES,
  MAX_EXTRACT_READ_BYTES,
} from "../src/agent/tools/webExtractTool.js";
import { webFetchTool } from "../src/agent/tools/webResearchTools.js";
import { buildToolRegistry } from "../src/agent/tools/index.js";
import { getToolMeta } from "@jarvis/agent";
import { createIntegrations } from "@jarvis/integrations";
import {
  FakeHttp,
  MemoryTokenStore,
  FixedClock as IntegrationsFixedClock,
  FakeLlm as IntegrationsFakeLlm,
} from "@jarvis/integrations/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeIntegrations() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-web-extract-test-"));
  return createIntegrations({
    http: new FakeHttp(),
    clock: new IntegrationsFixedClock(),
    tokenStore: new MemoryTokenStore(),
    llm: new IntegrationsFakeLlm(),
    dataDir: dir,
  });
}

const ORIGINAL_KEY = process.env["FIRECRAWL_API_KEY"];

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

/** Live-probed { success:true, data:{ markdown, metadata } } envelope, in one place. */
function firecrawlResponse(markdown: string, metadata: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: true, data: { markdown, metadata } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env["FIRECRAWL_API_KEY"] = "test-firecrawl-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env["FIRECRAWL_API_KEY"];
  else process.env["FIRECRAWL_API_KEY"] = ORIGINAL_KEY;
});

describe("web_extract (Firecrawl)", () => {
  it("returns clean markdown plus metadata on the happy path", async () => {
    const tool = makeWebExtractTool(
      fakeFetch(() =>
        firecrawlResponse("# Example Domain\nSome text.", {
          title: "Example Domain",
          sourceURL: "https://example.com",
          statusCode: 200,
          creditsUsed: 1,
        }),
      ),
    );

    const result = (await tool.run({ url: "https://example.com" })) as {
      ok: boolean;
      url: string;
      markdown: string;
      truncated: boolean;
      title?: string;
      statusCode?: number;
      creditsUsed?: number;
    };

    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://example.com");
    expect(result.markdown).toBe("# Example Domain\nSome text.");
    expect(result.truncated).toBe(false);
    expect(result.title).toBe("Example Domain");
    expect(result.statusCode).toBe(200);
    expect(result.creditsUsed).toBe(1);
  });

  it("sends exactly one POST to the Firecrawl scrape endpoint with the right shape", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tool = makeWebExtractTool(
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return firecrawlResponse("body", {});
      }),
    );

    await tool.run({ url: "https://example.com" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-firecrawl-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      url: string;
      formats: string[];
      onlyMainContent: boolean;
      timeout: number;
    };
    expect(body.url).toBe("https://example.com");
    expect(body.formats).toEqual(["markdown"]);
    expect(body.onlyMainContent).toBe(true);
    expect(typeof body.timeout).toBe("number");
    expect(body.timeout).toBeLessThan(40_000);
  });

  it("degrades gracefully without FIRECRAWL_API_KEY (no fetch call)", async () => {
    delete process.env["FIRECRAWL_API_KEY"];
    let called = false;
    const tool = makeWebExtractTool(
      fakeFetch(() => {
        called = true;
        return firecrawlResponse("x", {});
      }),
    );

    const result = (await tool.run({ url: "https://example.com" })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("FIRECRAWL_API_KEY");
    expect(called).toBe(false);
  });

  it("returns ok:false with status+code on HTTP 400 (live-probed BAD_REQUEST body)", async () => {
    const tool = makeWebExtractTool(
      fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              success: false,
              code: "BAD_REQUEST",
              error: "URL must have a valid top-level domain or be a valid path",
              details: [],
            }),
            { status: 400 },
          ),
      ),
    );

    const result = (await tool.run({ url: "https://example.com" })) as {
      ok: boolean;
      status: number;
      code?: string;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
    expect(result.error).toContain("valid top-level domain");
  });

  it.each([402, 429])(
    "returns ok:false with status %i on the doc-sourced { error } body",
    async (status) => {
      const tool = makeWebExtractTool(
        fakeFetch(() => new Response(JSON.stringify({ error: `HTTP ${status} from Firecrawl` }), { status })),
      );

      const result = (await tool.run({ url: "https://example.com" })) as {
        ok: boolean;
        status: number;
        error: string;
      };

      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
    },
  );

  it("returns ok:false on a 200 with body success:false (defensive second check)", async () => {
    const tool = makeWebExtractTool(
      fakeFetch(
        () =>
          new Response(JSON.stringify({ success: false, code: "UNKNOWN_ERROR", error: "boom" }), {
            status: 200,
          }),
      ),
    );

    const result = (await tool.run({ url: "https://example.com" })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it("returns ok:false instead of throwing on an unparseable 200 body", async () => {
    const tool = makeWebExtractTool(fakeFetch(() => new Response("not json", { status: 200 })));

    const result = (await tool.run({ url: "https://example.com" })) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on network failure instead of throwing", async () => {
    const tool = makeWebExtractTool(
      fakeFetch(() => {
        throw new Error("network down");
      }),
    );

    const result = (await tool.run({ url: "https://example.com" })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });

  it("returns ok:false on abort/timeout instead of rejecting", async () => {
    const tool = makeWebExtractTool(
      fakeFetch(() => {
        throw new DOMException("The operation was aborted", "AbortError");
      }),
    );

    const result = (await tool.run({ url: "https://example.com" })) as { ok: boolean };

    expect(result.ok).toBe(false);
  });

  it("truncates markdown past MAX_EXTRACT_BYTES with a marker", async () => {
    const big = "x".repeat(MAX_EXTRACT_BYTES + 5_000);
    const tool = makeWebExtractTool(fakeFetch(() => firecrawlResponse(big, {})));

    const result = (await tool.run({ url: "https://example.com" })) as {
      ok: boolean;
      markdown: string;
      truncated: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThanOrEqual(MAX_EXTRACT_BYTES + 50);
    expect(result.markdown).toContain("[truncated");
  });

  it("stops reading a chunk-streamed body at the MAX_EXTRACT_READ_BYTES wire cap and degrades to ok:false", async () => {
    // A body far past the wire cap: the reader loop must stop pulling chunks at
    // the cap (never buffering the rest), leaving a mid-JSON prefix that fails
    // parse — the structured ok:false degrade path, not a throw or a hang.
    const bigEnvelope = JSON.stringify({
      success: true,
      data: { markdown: "y".repeat(MAX_EXTRACT_READ_BYTES * 2) },
    });
    let chunksServed = 0;
    const chunkSize = 64 * 1024;
    const bytes = new TextEncoder().encode(bigEnvelope);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        chunksServed++;
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
    const tool = makeWebExtractTool(
      fakeFetch(() => new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    const result = (await tool.run({ url: "https://example.com" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    // The cap stops the read: only ~MAX_EXTRACT_READ_BYTES/chunkSize chunks are
    // ever pulled off the wire, not the whole 512 KB+ body.
    expect(chunksServed * chunkSize).toBeLessThan(bytes.length);
    expect(chunksServed).toBeLessThanOrEqual(Math.ceil(MAX_EXTRACT_READ_BYTES / chunkSize) + 1);
  });

  it("still parses a chunk-streamed body under the wire cap (streaming reader is not lossy)", async () => {
    const markdown = "# Streamed\n" + "z".repeat(10_000);
    const bytes = new TextEncoder().encode(JSON.stringify({ success: true, data: { markdown } }));
    const chunkSize = 1024;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
    });
    const tool = makeWebExtractTool(
      fakeFetch(() => new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    const result = (await tool.run({ url: "https://example.com" })) as {
      ok: boolean;
      markdown: string;
      truncated: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.markdown).toBe(markdown);
    expect(result.truncated).toBe(false);
  });

  it("rejects non-http(s) URLs before ever calling fetch", async () => {
    let called = false;
    const tool = makeWebExtractTool(
      fakeFetch(() => {
        called = true;
        return firecrawlResponse("x", {});
      }),
    );

    await expect(tool.run({ url: "file:///etc/passwd" })).rejects.toThrow();
    await expect(tool.run({ url: "javascript:alert(1)" })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("is readOnly and returnsExternalContent, with read_only risk metadata", () => {
    const tool = makeWebExtractTool(); // registration happens at build time
    expect(tool.readOnly).toBe(true);
    expect(tool.returnsExternalContent).toBe(true);
    const meta = getToolMeta("web_extract");
    expect(meta?.sideEffects).toBe("read_only");
    expect(meta?.reversible).toBe(true);
  });

  it("never leaks the API key on any failure path", async () => {
    process.env["FIRECRAWL_API_KEY"] = "fc-SENTINEL-must-not-leak";

    const badRequest = makeWebExtractTool(
      fakeFetch(
        () =>
          new Response(JSON.stringify({ success: false, code: "BAD_REQUEST", error: "bad url" }), {
            status: 400,
          }),
      ),
    );
    const paymentRequired = makeWebExtractTool(
      fakeFetch(() => new Response(JSON.stringify({ error: "payment required" }), { status: 402 })),
    );
    const serverSuccessFalse = makeWebExtractTool(
      fakeFetch(
        () =>
          new Response(
            JSON.stringify({ success: false, code: "UNKNOWN_ERROR", error: "server exploded" }),
            { status: 500 },
          ),
      ),
    );
    const networkThrow = makeWebExtractTool(
      fakeFetch(() => {
        throw new Error("network down");
      }),
    );

    for (const tool of [badRequest, paymentRequired, serverSuccessFalse, networkThrow]) {
      const result = await tool.run({ url: "https://example.com" });
      expect(JSON.stringify(result)).not.toContain("fc-SENTINEL-must-not-leak");
    }
  });
});

// ── Registry wiring ───────────────────────────────────────────────────────────

describe("registry wiring", () => {
  it("buildToolRegistry includes web_extract alongside the existing tools (additive, not a replacement)", () => {
    const integrations = makeIntegrations();
    const registry = buildToolRegistry(integrations);

    expect(registry.has("web_extract")).toBe(true);
    expect(registry.has("web_search")).toBe(true);
    expect(registry.has("web_fetch")).toBe(true);
    expect(registry.has("todo_list")).toBe(true);
  });
});

// ── Planner steering (D-02) ──────────────────────────────────────────────────

describe("planner steering", () => {
  it("web_extract and web_fetch descriptions cross-reference each other", () => {
    const extractTool = makeWebExtractTool();
    expect(extractTool.description).toContain("web_fetch");
    expect(webFetchTool.description).toContain("web_extract");
  });
});
