/**
 * Tests for CaptureService.captureDocument + MemoryStore.documentExists:
 * two-tier dedup (fast doc-level skip on doc_id, chunk-level backstop) and the
 * bi-temporal re-capture-on-edit behavior.
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
  const dir = mkdtempSync(join(tmpdir(), "jarvis-doc-cap-"));
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

describe("CaptureService.captureDocument", () => {
  it("captures chunks, skips an unchanged re-scan, re-captures on edit", async () => {
    const { store, capture } = make();
    const text = tokens(100);

    expect(store.documentExists("nope")).toBe(false);

    const first = await capture.captureDocument({ path: "a.txt", text, chunkOpts: MULTI });
    expect(first.skipped).toBe(false);
    expect(first.total).toBeGreaterThan(1);
    expect(first.inserted).toBe(first.total);
    expect(store.documentExists(first.docId)).toBe(true);

    // Same text → doc-level skip (no re-chunking, nothing inserted).
    const again = await capture.captureDocument({ path: "a.txt", text, chunkOpts: MULTI });
    expect(again.skipped).toBe(true);
    expect(again.inserted).toBe(0);
    expect(again.docId).toBe(first.docId);

    // Edited text → new doc_id; unchanged leading chunks dedup, changed tail re-captures.
    const edited = await capture.captureDocument({ path: "a.txt", text: `${text} tok999`, chunkOpts: MULTI });
    expect(edited.skipped).toBe(false);
    expect(edited.docId).not.toBe(first.docId);
    expect(edited.inserted).toBeGreaterThan(0);
    expect(edited.inserted).toBeLessThan(edited.total); // most chunks were unchanged
  });

  it("journals chunk records as files-sourced and pending consolidation", async () => {
    const { store, capture } = make();
    const r = await capture.captureDocument({ path: "doc.txt", text: tokens(100), chunkOpts: MULTI });
    const pending = store.getPendingExperienceRecords().filter((p) => p.source === "files");
    expect(pending).toHaveLength(r.total);
    expect(pending.every((p) => p.type === "document")).toBe(true);
  });

  it("returns a zero result for empty text without touching the store", async () => {
    const { capture } = make();
    const r = await capture.captureDocument({ path: "blank.txt", text: "   \n  " });
    expect(r).toMatchObject({ skipped: false, inserted: 0, total: 0 });
  });
});

describe("CaptureService.captureDocument - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  it("a captured document chunk is recallable by content after force-consolidation", async () => {
    const marker = "eval-canary-doc-2209";
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
          text: `Document mentions ${marker}`,
          confidence: 0.9,
        },
      ]),
    );

    const body = `Reminder: ${marker} needs review`;
    const captured = await capture.captureDocument({
      path: "mem06-doc.txt",
      text: body,
      chunkOpts: MULTI,
    });
    expect(captured.skipped).toBe(false);
    expect(captured.inserted).toBeGreaterThanOrEqual(1);
    // Body fits inside MULTI's targetChars=60 as a single chunk, so the
    // marker is never split across a chunk boundary.
    expect(captured.total).toBe(1);

    const result = await consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.errors).toHaveLength(0);

    const results = await retrieval.retrieve(`${marker} review`, { k: 5 });
    const hit = results.find((r) => r.text.includes(marker));
    expect(hit).toBeDefined();
  });
});
