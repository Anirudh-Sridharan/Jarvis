/**
 * Gmail actions — agent-facing email operations (feature 18):
 *   searchEmail / getEmailThread (read) · sendEmail / createEmailDraft (write)
 *
 * Deterministic transport ONLY, mirroring the calendar write engine:
 *   - No approval logic here. email_send is gated as outward_comm in the agent
 *     ReAct loop (feature 17) BEFORE tool.run() ever calls sendEmail.
 *   - Privacy stance of the gmail sync connector is preserved: bodies are
 *     returned to the caller transiently, NEVER persisted by this module.
 *
 * TODO(scale): text/plain only — no HTML bodies or attachments. Replies pass
 * threadId (Gmail threads them); full RFC References/In-Reply-To chaining is
 * not implemented.
 */

import type { HttpClient, HttpResponse, TokenStore } from "../types.js";
import { getAccessToken } from "../framework/oauth.js";
import { getRefreshConfig } from "../framework/providers.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailDeps {
  http: HttpClient;
  tokenStore: TokenStore;
}

export interface EmailSearchHit {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export interface EmailThread {
  id: string;
  messages: EmailMessage[];
}

export interface EmailSendRequest {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Gmail thread to reply into (omit for a new conversation). */
  threadId?: string;
}

export interface EmailSendResult {
  ok: boolean;
  messageId?: string;
  threadId?: string;
  draftId?: string;
  error?: { code: number; reason: string; retryable: boolean };
}

// ── Read: search / thread ─────────────────────────────────────────────────────

/**
 * Search messages with a Gmail query string. Returns lightweight hits
 * (metadata only). Read tools THROW on failure — the agent ReAct loop turns
 * tool errors into observations. Per-hit metadata misses are tolerated
 * (skipped), matching the sync connector's behavior.
 */
export async function searchEmail(
  query: string,
  maxResults: number,
  deps: GmailDeps,
): Promise<EmailSearchHit[]> {
  const token = await getAccessToken("gmail", deps.tokenStore, deps.http, getRefreshConfig("gmail"));

  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const listRes = await deps.http.request({
    method: "GET",
    url: `${GMAIL_BASE}/messages?${params}`,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (listRes.status !== 200) {
    throw new Error(`Gmail messages.list failed: HTTP ${listRes.status}`);
  }

  const data = listRes.body as { messages?: Array<{ id: string; threadId: string }> };
  const hits: EmailSearchHit[] = [];
  for (const msg of data.messages ?? []) {
    const metaRes = await deps.http.request({
      method: "GET",
      url: `${GMAIL_BASE}/messages/${msg.id}?format=metadata&metadataHeaders=Subject,From,Date`,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (metaRes.status !== 200) continue; // tolerate per-message misses
    const meta = metaRes.body as RawGmailMessage;
    const headers = meta.payload?.headers ?? [];
    hits.push({
      messageId: msg.id,
      threadId: msg.threadId,
      subject: headerValue(headers, "subject") ?? "(no subject)",
      from: headerValue(headers, "from") ?? "",
      date: headerValue(headers, "date") ?? "",
    });
  }
  return hits;
}

/**
 * Fetch a full thread and extract each message's text/plain body.
 * Bodies are returned transiently — nothing is persisted.
 */
export async function getEmailThread(
  threadId: string,
  deps: GmailDeps,
): Promise<EmailThread> {
  const token = await getAccessToken("gmail", deps.tokenStore, deps.http, getRefreshConfig("gmail"));

  const res = await deps.http.request({
    method: "GET",
    url: `${GMAIL_BASE}/threads/${encodeURIComponent(threadId)}?format=full`,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(`Gmail threads.get failed: HTTP ${res.status}`);
  }

  const data = res.body as { id?: string; messages?: RawGmailMessage[] };
  const messages: EmailMessage[] = (data.messages ?? []).map((m) => {
    const headers = m.payload?.headers ?? [];
    return {
      id: m.id ?? "",
      threadId: m.threadId ?? threadId,
      from: headerValue(headers, "from") ?? "",
      to: headerValue(headers, "to") ?? "",
      subject: headerValue(headers, "subject") ?? "(no subject)",
      date: headerValue(headers, "date") ?? "",
      body: extractPlainTextBody(m.payload) ?? "",
    };
  });
  return { id: data.id ?? threadId, messages };
}

interface RawGmailHeader {
  name?: string;
  value?: string;
}

interface RawGmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: RawGmailPart[];
}

interface RawGmailMessage {
  id?: string;
  threadId?: string;
  payload?: RawGmailPart & { headers?: RawGmailHeader[] };
}

function headerValue(headers: RawGmailHeader[], name: string): string | undefined {
  return headers.find((h) => h.name?.toLowerCase() === name)?.value;
}

/** Depth-first walk of MIME parts for the first text/plain body. */
function extractPlainTextBody(part: RawGmailPart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainTextBody(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ── Write: send / draft ───────────────────────────────────────────────────────

/** Send an email. Caller must have cleared the approval gate (outward_comm). */
export async function sendEmail(
  req: EmailSendRequest,
  deps: GmailDeps,
): Promise<EmailSendResult> {
  return executeMessageWrite(req, deps, "send");
}

/** Create a draft (never leaves the account — internal_write risk class). */
export async function createEmailDraft(
  req: EmailSendRequest,
  deps: GmailDeps,
): Promise<EmailSendResult> {
  return executeMessageWrite(req, deps, "draft");
}

async function executeMessageWrite(
  req: EmailSendRequest,
  deps: GmailDeps,
  mode: "send" | "draft",
): Promise<EmailSendResult> {
  if (req.to.length === 0) {
    return { ok: false, error: { code: 400, reason: "at least one recipient required", retryable: false } };
  }

  let token: string;
  try {
    token = await getAccessToken("gmail", deps.tokenStore, deps.http, getRefreshConfig("gmail"));
  } catch (err) {
    return {
      ok: false,
      error: { code: 401, reason: err instanceof Error ? err.message : String(err), retryable: false },
    };
  }

  const raw = encodeBase64Url(buildRfc2822(req));
  const message: Record<string, unknown> = { raw };
  if (req.threadId) message["threadId"] = req.threadId;

  const res = await deps.http.request({
    method: "POST",
    url: mode === "send" ? `${GMAIL_BASE}/messages/send` : `${GMAIL_BASE}/drafts`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: mode === "send" ? message : { message },
  });

  if (res.status !== 200 && res.status !== 201) {
    return { ok: false, error: mapGmailError(res) };
  }

  if (mode === "send") {
    const body = res.body as { id?: string; threadId?: string };
    return { ok: true, messageId: body.id, threadId: body.threadId };
  }
  const body = res.body as { id?: string; message?: { id?: string; threadId?: string } };
  return { ok: true, draftId: body.id, messageId: body.message?.id, threadId: body.message?.threadId };
}

// ── RFC 2822 message builder ──────────────────────────────────────────────────

/**
 * Build a minimal RFC 2822 plain-text message (CRLF line endings).
 * Subject is RFC 2047 base64-encoded when it contains non-ASCII characters.
 */
export function buildRfc2822(req: EmailSendRequest): string {
  const lines = [
    `To: ${req.to.join(", ")}`,
    ...(req.cc && req.cc.length > 0 ? [`Cc: ${req.cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(req.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(req.body, "utf8").toString("base64"),
  ];
  return lines.join("\r\n");
}

function encodeSubject(subject: string): string {
  // ASCII subjects pass through; anything else gets RFC 2047 encoded-word form.
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function encodeBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function mapGmailError(res: HttpResponse): NonNullable<EmailSendResult["error"]> {
  const retryable = res.status === 429 || res.status >= 500;
  return { code: res.status, reason: `Gmail API error: HTTP ${res.status}`, retryable };
}
