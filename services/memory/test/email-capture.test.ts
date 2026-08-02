/**
 * Tests for CaptureService.captureEmail: chunk-level dedup idempotency (emails
 * are immutable, so a re-capture inserts nothing) and that records journal as
 * gmail/email pending consolidation.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { CaptureService } from "../src/capture/capture.js";
import { ConsolidationService } from "../src/consolidation/consolidation.js";
import { RetrievalService } from "../src/retrieval/retrieval.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";

function tokens(n: number): string {
  return Array.from({ length: n }, (_, i) => `tok${String(i).padStart(3, "0")}`).join(" ");
}

const MULTI = { targetChars: 60, overlapChars: 0, minChars: 10 };

function make(llm: FakeLlm = new FakeLlm()) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-email-cap-"));
  const db = openDatabase(dir);
  // Same embedder instance shared across store/capture/consolidation/retrieval
  // so vector lookups line up (FakeEmbedder is stateless/deterministic, but
  // this keeps the wiring identical to how the real system is constructed).
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const capture = new CaptureService(store, embedder);
  const consolidation = new ConsolidationService(store, llm, embedder);
  const retrieval = new RetrievalService(store, embedder);
  return { store, capture, embedder, consolidation, retrieval, llm };
}

const MSG = {
  messageId: "m1",
  threadId: "t1",
  from: "Alice <alice@example.com>",
  to: "me@example.com",
  subject: "Kickoff",
  date: "Mon, 01 Jun 2026 08:00:00 +0000",
};

describe("CaptureService.captureEmail", () => {
  it("captures every chunk on first sight, nothing on a re-capture (immutable)", async () => {
    const { capture } = make();
    const body = tokens(100);

    const first = await capture.captureEmail({ ...MSG, body, chunkOpts: MULTI });
    expect(first.total).toBeGreaterThan(1);
    expect(first.inserted).toBe(first.total);

    const again = await capture.captureEmail({ ...MSG, body, chunkOpts: MULTI });
    expect(again.total).toBe(first.total);
    expect(again.inserted).toBe(0); // chunk-level dedup
  });

  it("journals chunk records as gmail-sourced email, pending consolidation", async () => {
    const { store, capture } = make();
    const r = await capture.captureEmail({ ...MSG, body: tokens(100), chunkOpts: MULTI });
    const pending = store.getPendingExperienceRecords().filter((p) => p.source === "gmail");
    expect(pending).toHaveLength(r.total);
    expect(pending.every((p) => p.type === "email")).toBe(true);
  });

  it("returns a zero result for an empty body without inserting", async () => {
    const { store, capture } = make();
    const r = await capture.captureEmail({ ...MSG, body: "   \n " });
    expect(r).toEqual({ inserted: 0, total: 0 });
    expect(store.getPendingExperienceRecords().filter((p) => p.source === "gmail")).toHaveLength(0);
  });
});

describe("CaptureService.captureEmail - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  it("a captured email chunk is recallable by content after force-consolidation", async () => {
    const marker = "eval-canary-email-6650";
    const { capture, consolidation, retrieval, llm } = make();
    // FakeLlm's default extraction is a fixed "User prefers TypeScript" fact —
    // the chunk's own literal text never reaches the graph unless an override
    // is registered on a distinctive substring of its body. reflectInsights()
    // also embeds the same raw chunk text under "Recent experiences:", so
    // suppress that prompt explicitly (checked first) to avoid a duplicate
    // episode via indexInsightAsEpisode().
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        {
          entity: "self",
          predicate: "mentions",
          object: marker,
          text: `Email mentions ${marker}`,
          confidence: 0.9,
        },
      ]),
    );

    const body = `Kickoff notes: ${marker} action item`;
    const first = await capture.captureEmail({
      ...MSG,
      messageId: "mem06-email-1",
      body,
      chunkOpts: MULTI,
    });
    expect(first.inserted).toBeGreaterThanOrEqual(1);

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.errors).toHaveLength(0);

    const results = await retrieval.retrieve(`${marker} action item`, { k: 5 });
    const hit = results.find((r) => r.text.includes(marker));
    expect(hit).toBeDefined();
  });
});
