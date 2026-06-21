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
import { FakeEmbedder } from "../src/testing/fakes.js";

function tokens(n: number): string {
  return Array.from({ length: n }, (_, i) => `tok${String(i).padStart(3, "0")}`).join(" ");
}

const MULTI = { targetChars: 60, overlapChars: 0, minChars: 10 };

function make() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-doc-cap-"));
  const db = openDatabase(dir);
  const store = new MemoryStore(db, new FakeEmbedder());
  const capture = new CaptureService(store, new FakeEmbedder());
  return { store, capture };
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
