/**
 * Shared endpoints + small client helpers. NEXT_PUBLIC_* vars are inlined at
 * build time, so this module is safe in both server and client components.
 */

/** Core service base URL (trailing slash stripped). */
export const CORE_URL =
  process.env.NEXT_PUBLIC_CORE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:8080";

/** This dashboard's own base URL — pages fetch their BFF routes through it. */
export const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

/** Unique-enough id for client-side list keys / optimistic message ids. */
export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
