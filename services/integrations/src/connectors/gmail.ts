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
import { getOAuthAccessToken } from "../framework/providers.js";
import { httpError } from "../framework/httpError.js";
import { metricPointFactory } from "../framework/normalize.js";

const MAX_PAGES = 10;

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
    const token = await getOAuthAccessToken("gmail", tokenStore, http);

    const since = cursor?.highWater ?? sevenDaysAgo();
    const events: WorkEvent[] = [];

    // Search for received messages. Gmail returns newest-first, so we MUST
    // follow nextPageToken — otherwise >100 new messages means the cursor
    // advances past unfetched older ones, losing them forever.
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        q: `after:${toGmailDate(since)}`,
        maxResults: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const receivedRes = await http.request({
        method: "GET",
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
        headers: { Authorization: `Bearer ${token}` },
      });

      // A failed page-level list fetch must fail the run: the cursor would
      // otherwise advance past messages we never saw.
      if (receivedRes.status !== 200) {
        throw httpError("Gmail messages.list failed", receivedRes);
      }

      const data = receivedRes.body as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };

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
        // Per-message metadata misses are tolerated (skipped), not fatal.
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
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
        const now = new Date();
        // Bucket ts to the start of the current hour: re-runs within the hour
        // produce the same deterministic id and upsert instead of appending.
        const hourStart = new Date(now);
        hourStart.setUTCMinutes(0, 0, 0);
        const ts = hourStart.toISOString();
        const point = metricPointFactory("gmail", now.toISOString());
        points.push(
          point({ metric: "gmail.unread_count", value: label.messagesUnread, unit: "count", ts })
        );
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

  // Use internalDate (ms) → Date header → now. Each candidate is validated:
  // an unparseable date must not throw (a poison message would wedge every
  // subsequent sync because the cursor never advances past it).
  const ts = parseMessageTs(msg.internalDate, dateHeader);

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
  const point = metricPointFactory("gmail");
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
    points.push(point({ metric: "gmail.received", value: count, unit: "count", ts: `${day}T00:00:00Z` }));
  }

  for (const [day, count] of sentByDay.entries()) {
    points.push(point({ metric: "gmail.sent", value: count, unit: "count", ts: `${day}T00:00:00Z` }));
  }

  return points;
}

/** Best-effort message timestamp: internalDate (ms) → Date header → now. */
function parseMessageTs(internalDate?: string, dateHeader?: string): string {
  if (internalDate) {
    const d = new Date(parseInt(internalDate, 10));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function sevenDaysAgo(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

/** Convert ISO timestamp to Gmail after: date format (YYYY/MM/DD). */
function toGmailDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "/");
}
