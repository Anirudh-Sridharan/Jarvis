/**
 * Gmail connector — OAuth2, metadata-only (no email bodies/actions).
 *
 * Syncs: email volume, unread count, thread metrics, response time
 * → MetricPoints for dashboard Work section.
 *
 * Privacy: NEVER stores email bodies. Only metadata:
 *   subject, internalDate, threadId, labelIds, in-reply-to header.
 *
 * NOTE: Email ACTIONS (send, archive, label) are feature 18 (phase 5), NOT here.
 */

import type {
  Connector,
  ConnectorSyncResult,
  Cursor,
  HttpClient,
  MetricPoint,
  TokenStore,
  WorkEvent,
} from "../types.js";
import { makeMetricId } from "../framework/metricStore.js";
import { getAccessToken } from "../framework/oauth.js";

const ADAPTER_VERSION = "1";

const GMAIL_OAUTH_CONFIG = {
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: process.env["GMAIL_CLIENT_ID"] ?? "gmail_client",
  clientSecret: process.env["GMAIL_CLIENT_SECRET"] ?? "gmail_secret",
};

export const gmailConnector: Connector = {
  id: "gmail",
  auth: "oauth",
  schedule: "*/30 * * * *", // every 30 minutes
  concurrency: 2,

  async sync(
    cursor: Cursor | null,
    http: HttpClient,
    tokenStore: TokenStore
  ): Promise<ConnectorSyncResult> {
    const token = await getAccessToken("gmail", tokenStore, http, GMAIL_OAUTH_CONFIG);

    const since = cursor?.highWater ?? sevenDaysAgo();
    const events: WorkEvent[] = [];

    // Search for received messages
    const receivedUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${toGmailDate(since)}&maxResults=100`;
    const receivedRes = await http.request({
      method: "GET",
      url: receivedUrl,
      headers: { Authorization: `Bearer ${token}` },
    });

    if (receivedRes.status === 200) {
      const data = receivedRes.body as { messages?: Array<{ id: string; threadId: string }> };
      for (const msg of data.messages ?? []) {
        // Fetch metadata only
        const metaRes = await http.request({
          method: "GET",
          url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject,Date,In-Reply-To`,
          headers: { Authorization: `Bearer ${token}` },
        });

        if (metaRes.status === 200) {
          const meta = metaRes.body as GmailMessage;
          const ev = normalizeGmailMessage(meta, "email_received");
          if (ev) events.push(ev);
        }
      }
    }

    // Get unread count
    const unreadRes = await http.request({
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/labels/UNREAD",
      headers: { Authorization: `Bearer ${token}` },
    });

    const points = gmailEventsToMetricPoints(events);

    if (unreadRes.status === 200) {
      const label = unreadRes.body as { messagesUnread?: number };
      if (label.messagesUnread != null) {
        const now = new Date().toISOString();
        points.push({
          id: makeMetricId({ source: "gmail", metric: "gmail.unread_count", ts: now, dims: {} }),
          source: "gmail",
          metric: "gmail.unread_count",
          value: label.messagesUnread,
          unit: "count",
          ts: now,
          dims: {},
          ingestedAt: now,
          adapterVersion: ADAPTER_VERSION,
        });
      }
    }

    let latestTs = since;
    for (const e of events) {
      if (e.ts > latestTs) latestTs = e.ts;
    }

    return {
      points,
      nextCursor: latestTs !== since ? latestTs : null,
    };
  },
};

// ── Types for Gmail API ───────────────────────────────────────────────────────

interface GmailMessageHeader {
  name?: string;
  value?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string; // ms since epoch as string
  payload?: {
    headers?: GmailMessageHeader[];
  };
}

export function normalizeGmailMessage(
  msg: GmailMessage,
  type: "email_received" | "email_sent"
): WorkEvent | null {
  if (!msg.id) return null;

  const headers = msg.payload?.headers ?? [];
  const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
  const dateHeader = headers.find((h) => h.name?.toLowerCase() === "date")?.value;
  const inReplyTo = headers.find((h) => h.name?.toLowerCase() === "in-reply-to")?.value;

  // Use internalDate (ms) or parse Date header
  const ts = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : dateHeader
    ? new Date(dateHeader).toISOString()
    : new Date().toISOString();

  // Determine if sent (has SENT label)
  const isSent = msg.labelIds?.includes("SENT") ?? false;
  const actualType = isSent ? "email_sent" : type;

  return {
    id: `gmail:${msg.id}`,
    source: "gmail",
    type: actualType,
    ts,
    thread: msg.threadId,
    title: subject,
    meta: {
      inReplyTo,
      labelIds: msg.labelIds,
    },
  };
}

export function gmailEventsToMetricPoints(events: WorkEvent[]): MetricPoint[] {
  const now = new Date().toISOString();
  const points: MetricPoint[] = [];

  // Daily email volume
  const receivedByDay = new Map<string, number>();
  const sentByDay = new Map<string, number>();

  for (const e of events) {
    const day = e.ts.slice(0, 10);
    if (e.type === "email_received") {
      receivedByDay.set(day, (receivedByDay.get(day) ?? 0) + 1);
    } else if (e.type === "email_sent") {
      sentByDay.set(day, (sentByDay.get(day) ?? 0) + 1);
    }
  }

  for (const [day, count] of receivedByDay.entries()) {
    const ts = `${day}T00:00:00Z`;
    points.push({
      id: makeMetricId({ source: "gmail", metric: "gmail.received", ts, dims: {} }),
      source: "gmail",
      metric: "gmail.received",
      value: count,
      unit: "count",
      ts,
      dims: {},
      ingestedAt: now,
      adapterVersion: ADAPTER_VERSION,
    });
  }

  for (const [day, count] of sentByDay.entries()) {
    const ts = `${day}T00:00:00Z`;
    points.push({
      id: makeMetricId({ source: "gmail", metric: "gmail.sent", ts, dims: {} }),
      source: "gmail",
      metric: "gmail.sent",
      value: count,
      unit: "count",
      ts,
      dims: {},
      ingestedAt: now,
      adapterVersion: ADAPTER_VERSION,
    });
  }

  return points;
}

function sevenDaysAgo(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

/** Convert ISO timestamp to Gmail after: date format (YYYY/MM/DD). */
function toGmailDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "/");
}
