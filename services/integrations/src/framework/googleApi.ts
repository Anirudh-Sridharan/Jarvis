/**
 * Shared Google API error mapping for the live write/action paths
 * (calendar + gmail). One definition of retryability so a policy fix never
 * diverges between connectors.
 */

import type { HttpResponse } from "../types.js";

export interface GoogleApiError {
  code: number;
  reason: string;
  retryable: boolean;
}

export function mapGoogleApiError(
  res: HttpResponse,
  api: "Gmail" | "Google Calendar",
  source: "gmail" | "gcal",
): GoogleApiError {
  const retryable = res.status === 429 || res.status >= 500;
  let reason: string;
  if (res.status === 412) {
    reason =
      "etag mismatch (resource changed since last sync) — re-sync and retry with a fresh etag";
  } else if (res.status === 403) {
    // The most common 403 for this single-user app is a token consented
    // before the scopes were widened — make the fix discoverable at runtime.
    reason =
      `${api} API error: HTTP 403 — if you connected before write scopes were added, ` +
      `re-run \`npm run connect -- ${source}\` to re-consent.`;
  } else {
    reason = `${api} API error: HTTP ${res.status}`;
  }
  return { code: res.status, reason, retryable };
}
