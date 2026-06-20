/**
 * Shared Server-Component fetch helper for the BFF.
 *
 * Every dashboard page fetches its own /api/* route(s) over HTTP (through the
 * app's own base URL) and renders the returned WidgetEnvelope<T>. They all
 * shared the same try/catch that, on a transport failure, synthesizes an
 * `error` envelope so a page never throws — it degrades to an error card. This
 * collapses that duplicated boilerplate into one place.
 *
 * Server-only: pages call this during render on the Node side; it must not be
 * bundled into a client component.
 */

import "server-only";

import type { WidgetEnvelope } from "@/app/lib/contracts";
import { APP_BASE_URL } from "@/app/lib/clientEnv";

/**
 * GET `path` (relative to the dashboard's own base URL) and parse the JSON as a
 * WidgetEnvelope<T>. On any transport error, return a synthetic `error`
 * envelope with `unreachableMessage` instead of throwing.
 */
export async function fetchEnvelope<T>(
  path: string,
  unreachableMessage = "Service unreachable",
): Promise<WidgetEnvelope<T>> {
  try {
    const res = await fetch(`${APP_BASE_URL}${path}`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<T>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: unreachableMessage },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}
