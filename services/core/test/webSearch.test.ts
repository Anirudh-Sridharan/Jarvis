/**
 * web_search tool tests — Brave Search API client with injected fetchFn.
 * No network: fetchFn is stubbed; BRAVE_API_KEY is controlled per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeWebSearchTool } from "../src/agent/tools/webResearchTools.js";

const ORIGINAL_KEY = process.env["BRAVE_API_KEY"];

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function braveResponse(results: Array<{ title: string; url: string; description: string }>): Response {
  return new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env["BRAVE_API_KEY"] = "test-brave-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env["BRAVE_API_KEY"];
  else process.env["BRAVE_API_KEY"] = ORIGINAL_KEY;
});

describe("web_search (Brave)", () => {
  it("maps results to title/url/snippet and sends the subscription token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tool = makeWebSearchTool(
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return braveResponse([
          { title: "MLX docs", url: "https://ml-explore.github.io", description: "Apple MLX" },
          { title: "Qwen", url: "https://qwenlm.ai", description: "Qwen models" },
        ]);
      }),
    );

    const result = (await tool.run({ query: "mlx qwen", max_results: 5 })) as {
      ok: boolean;
      results: Array<{ title: string; url: string; snippet: string }>;
      count: number;
    };

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.results[0]).toEqual({
      title: "MLX docs",
      url: "https://ml-explore.github.io",
      snippet: "Apple MLX",
    });

    expect(calls[0]!.url).toContain("api.search.brave.com/res/v1/web/search");
    expect(calls[0]!.url).toContain("q=mlx+qwen");
    expect(calls[0]!.url).toContain("count=5");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("test-brave-key");
  });

  it("caps results at max_results", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      title: `r${i}`,
      url: `https://example.com/${i}`,
      description: "d",
    }));
    const tool = makeWebSearchTool(fakeFetch(() => braveResponse(many)));

    const result = (await tool.run({ query: "q", max_results: 3 })) as {
      results: unknown[];
    };
    expect(result.results).toHaveLength(3);
  });

  it("degrades gracefully without BRAVE_API_KEY (no fetch call)", async () => {
    delete process.env["BRAVE_API_KEY"];
    let called = false;
    const tool = makeWebSearchTool(
      fakeFetch(() => {
        called = true;
        return braveResponse([]);
      }),
    );

    const result = (await tool.run({ query: "anything" })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("BRAVE_API_KEY");
    expect(called).toBe(false);
  });

  it("returns ok:false with status on HTTP errors", async () => {
    const tool = makeWebSearchTool(
      fakeFetch(() => new Response("{}", { status: 429 })),
    );

    const result = (await tool.run({ query: "q" })) as { ok: boolean; status: number; error: string };

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toContain("429");
  });

  it("returns ok:false on network failure instead of throwing", async () => {
    const tool = makeWebSearchTool(
      fakeFetch(() => {
        throw new Error("network down");
      }),
    );

    const result = (await tool.run({ query: "q" })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});
