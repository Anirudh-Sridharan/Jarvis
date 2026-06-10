/**
 * Shared HTTP error formatting for connector sync/action paths.
 *
 * A bare "HTTP 403" hides the fix (e.g. Google's body says exactly which API
 * to enable and where) — surface a short detail from the response body so the
 * actionable message reaches the CLI and the dashboard.
 */

const MAX_DETAIL_LEN = 300;

/** Best-effort short human-readable detail from an error response body. */
export function httpErrorDetail(body: unknown): string {
  let detail = "";
  if (typeof body === "string") {
    detail = body;
  } else if (body && typeof body === "object") {
    const obj = body as { error?: unknown; message?: unknown };
    if (obj.error && typeof obj.error === "object") {
      const msg = (obj.error as { message?: unknown }).message;
      if (typeof msg === "string") detail = msg;
    } else if (typeof obj.error === "string") {
      detail = obj.error;
    } else if (typeof obj.message === "string") {
      detail = obj.message;
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  return detail.length > MAX_DETAIL_LEN ? `${detail.slice(0, MAX_DETAIL_LEN)}…` : detail;
}

/** Build an Error like "Calendar sync failed: HTTP 403 — <body detail>". */
export function httpError(prefix: string, res: { status: number; body: unknown }): Error {
  const detail = httpErrorDetail(res.body);
  return new Error(`${prefix}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
}
