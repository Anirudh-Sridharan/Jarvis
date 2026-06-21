/**
 * Tests for the Gmail email-body ingester (runEmailIngest).
 *
 * Uses a fake EmailSource (no network/creds) and a real fake-backed MemorySystem.
 * Verifies: thread dedup (getThread once per thread), capture-only-matched-message
 * filtering, empty-body skip, getThread error tolerance, idempotent re-run dedup,
 * and default-query / override forwarding.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";
import type { EmailSearchHit, EmailThread } from "@jarvis/integrations";
import { runEmailIngest, DEFAULT_EMAIL_QUERY, type EmailSource } from "../src/memory/emailIngest.js";

function makeMemory() {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-email-mem-"));
  return createMemorySystem({ embedder: new FakeEmbedder(), llm: new FakeLlm(), dataDir });
}

function hit(messageId: string, threadId: string): EmailSearchHit {
  return { messageId, threadId, subject: `Subj ${messageId}`, from: "a@x.com", date: "Mon, 01 Jun 2026 08:00:00 +0000" };
}

function msg(id: string, threadId: string, body: string) {
  return { id, threadId, from: "Alice <alice@x.com>", to: "me@x.com", subject: `Subj ${id}`, date: "Mon, 01 Jun 2026 08:00:00 +0000", body };
}

/** Records calls; serves canned threads. */
class FakeEmailSource implements EmailSource {
  searchCalls: Array<{ query: string; maxResults: number }> = [];
  threadCalls: string[] = [];
  constructor(
    private readonly hits: EmailSearchHit[],
    private readonly threads: Record<string, EmailThread>,
    private readonly failThreads: Set<string> = new Set(),
  ) {}
  async search(query: string, maxResults: number): Promise<EmailSearchHit[]> {
    this.searchCalls.push({ query, maxResults });
    return this.hits;
  }
  async getThread(threadId: string): Promise<EmailThread> {
    this.threadCalls.push(threadId);
    if (this.failThreads.has(threadId)) throw new Error(`boom ${threadId}`);
    return this.threads[threadId]!;
  }
}

// Two threads. t1 has two matched messages (m1,m2) plus a non-matched reply (mX).
// t2 has a matched message (m3), a matched-but-empty one (m5, skipped), and a
// non-matched message (m6).
function scenario() {
  const hits = [hit("m1", "t1"), hit("m2", "t1"), hit("m3", "t2"), hit("m5", "t2")];
  const threads: Record<string, EmailThread> = {
    t1: { id: "t1", messages: [msg("m1", "t1", "First message body."), msg("m2", "t1", "Second body."), msg("mX", "t1", "Unmatched reply.")] },
    t2: { id: "t2", messages: [msg("m3", "t2", "Third body."), msg("m5", "t2", "   "), msg("m6", "t2", "Unmatched.")] },
  };
  return { hits, threads };
}

describe("runEmailIngest", () => {
  it("captures only matched, non-empty messages; fetches each thread once", async () => {
    const { hits, threads } = scenario();
    const email = new FakeEmailSource(hits, threads);
    const memory = makeMemory();

    const r = await runEmailIngest({ memory, email });

    expect(email.threadCalls.sort()).toEqual(["t1", "t2"]); // deduped — once each
    expect(r.scanned).toBe(4);
    expect(r.messages).toBe(3); // m1, m2, m3 (mX/m6 unmatched, m5 empty)
    expect(r.chunks).toBe(3); // short bodies → one chunk each
    expect(r.duplicates).toBe(0);
    expect(r.skipped).toBe(1); // m5 empty body
    expect(r.errors).toBe(0);

    const pending = memory.store.getPendingExperienceRecords().filter((p) => p.source === "gmail");
    expect(pending).toHaveLength(3);
    expect(pending.every((p) => p.type === "email")).toBe(true);
  });

  it("is idempotent — a re-run captures nothing new (chunk dedup)", async () => {
    const { hits, threads } = scenario();
    const memory = makeMemory();

    await runEmailIngest({ memory, email: new FakeEmailSource(hits, threads) });
    const second = await runEmailIngest({ memory, email: new FakeEmailSource(hits, threads) });

    expect(second.messages).toBe(3);
    expect(second.chunks).toBe(0);
    expect(second.duplicates).toBe(3);
    expect(second.skipped).toBe(1);
  });

  it("tolerates a getThread failure — counts the error and continues other threads", async () => {
    const { hits, threads } = scenario();
    const email = new FakeEmailSource(hits, threads, new Set(["t2"]));
    const memory = makeMemory();

    const r = await runEmailIngest({ memory, email });

    expect(r.errors).toBe(1);
    expect(r.messages).toBe(2); // t1's m1, m2 still captured
    expect(r.chunks).toBe(2);
  });

  it("uses the default query when none is supplied, and forwards an override", async () => {
    const { hits, threads } = scenario();

    const a = new FakeEmailSource(hits, threads);
    await runEmailIngest({ memory: makeMemory(), email: a });
    expect(a.searchCalls[0]!.query).toBe(DEFAULT_EMAIL_QUERY);
    expect(a.searchCalls[0]!.maxResults).toBe(100); // default cap

    const b = new FakeEmailSource(hits, threads);
    await runEmailIngest({ memory: makeMemory(), email: b, query: "from:boss", maxResults: 25 });
    expect(b.searchCalls[0]!.query).toBe("from:boss");
    expect(b.searchCalls[0]!.maxResults).toBe(25);
  });
});
