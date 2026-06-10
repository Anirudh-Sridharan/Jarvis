/**
 * FetchHttpClient — the real HttpClient implementation injected into
 * @jarvis/integrations connectors (which only ever see the interface).
 *
 * Behavior:
 *   - JSON-aware: object bodies are serialized; JSON responses are parsed.
 *   - Never throws on non-2xx — connectors branch on res.status themselves
 *     (matching FakeHttp semantics).
 *   - Per-request timeout via AbortSignal.
 *
 * fetchImpl is injectable so tests never touch the network.
 */

import type { HttpClient, HttpRequest, HttpResponse } from "@jarvis/integrations";

export interface FetchHttpOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class FetchHttpClient implements HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FetchHttpOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...req.headers };

    let body: string | undefined;
    if (req.body != null) {
      if (typeof req.body === "string") {
        body = req.body;
      } else {
        body = JSON.stringify(req.body);
        if (!hasHeader(headers, "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const res = await this.fetchImpl(req.url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let parsed: unknown = text;
    if (text && contentType.includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as raw text — caller sees what the server actually sent
      }
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    return { status: res.status, headers: responseHeaders, body: parsed };
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}
