/**
 * Gmail email-body ingest (second-brain capture breadth #3).
 *
 * Pulls recent Gmail messages (Inbox + Sent by default, excluding
 * promotions/social/spam/trash), extracts each message's plain-text body, and
 * captures it as chunked memory records via memory.capture.captureEmail. Idempotent
 * — capture dedups per chunk, so re-running the bounded query window drops
 * already-seen messages as duplicates. Consolidation (the scheduler, or
 * POST /consolidate) then promotes the chunks into the searchable graph.
 *
 * This is the live (network) layer; chunking and record-building live in the leaf
 * @jarvis/memory package, which never touches the network. The email source is
 * injectable (default = the live integrations.email) so tests stay hermetic — no
 * Gmail credentials or network required.
 *
 * Why search-then-thread: search returns metadata only (no body); getThread
 * returns each message's decoded text/plain body. We dedup thread ids, fetch each
 * thread once, and capture only the messages whose id matched the query — so a
 * promotional reply living inside a matched thread is not pulled in.
 */

import type { MemorySystem } from "@jarvis/memory";
import type { EmailSearchHit, EmailThread } from "@jarvis/integrations";

/** The injectable read surface — structurally satisfied by integrations.email. */
export interface EmailSource {
  search(query: string, maxResults: number): Promise<EmailSearchHit[]>;
  getThread(threadId: string): Promise<EmailThread>;
}

export interface EmailIngestResult {
  /** Search hits (candidate messages) returned by the query. */
  scanned: number;
  /** Matched, non-empty messages processed (whether newly captured or deduped). */
  messages: number;
  /** Chunk records newly journaled. */
  chunks: number;
  /** Chunk records that deduped (already captured). */
  duplicates: number;
  /** Matched messages skipped — no extractable text/plain body. */
  skipped: number;
  /** Per-thread getThread failures. */
  errors: number;
}

export interface EmailIngestDeps {
  memory: Pick<MemorySystem, "capture">;
  email: EmailSource;
  /** Gmail query override (default: DEFAULT_EMAIL_QUERY). */
  query?: string;
  /** Max search hits to fetch (default 100). */
  maxResults?: number;
}

/**
 * Inbox + Sent, excluding Promotions/Social/Spam/Trash, last 30 days.
 * `newer_than:30d` is server-relative, so this string is deterministic.
 */
export const DEFAULT_EMAIL_QUERY =
  "(in:inbox OR in:sent) -category:promotions -category:social -in:spam -in:trash newer_than:30d";

const DEFAULT_MAX_RESULTS = 100;

export async function runEmailIngest(deps: EmailIngestDeps): Promise<EmailIngestResult> {
  const res: EmailIngestResult = {
    scanned: 0,
    messages: 0,
    chunks: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
  };

  const query = deps.query ?? DEFAULT_EMAIL_QUERY;
  const maxResults = deps.maxResults ?? DEFAULT_MAX_RESULTS;

  const hits = await deps.email.search(query, maxResults);
  res.scanned = hits.length;

  const wanted = new Set(hits.map((h) => h.messageId));
  const threadIds = uniqueInOrder(hits.map((h) => h.threadId));

  for (const threadId of threadIds) {
    let thread: EmailThread;
    try {
      thread = await deps.email.getThread(threadId);
    } catch {
      res.errors++;
      continue;
    }

    for (const msg of thread.messages) {
      if (!wanted.has(msg.id)) continue; // matched-only: skip thread context noise
      if (!msg.body.trim()) {
        res.skipped++;
        continue;
      }
      const { inserted, total } = await deps.memory.capture.captureEmail({
        messageId: msg.id,
        threadId: msg.threadId,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        date: msg.date,
        body: msg.body,
      });
      res.messages++;
      res.chunks += inserted;
      res.duplicates += total - inserted;
    }
  }

  return res;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
