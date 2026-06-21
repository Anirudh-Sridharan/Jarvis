/**
 * Phase 3 retrofit: long Obsidian notes are chunked into multiple records
 * instead of collapsing to one deferred-embedding blob. Short/medium notes
 * (body within the defer threshold) stay single records — no churn for notes
 * already captured fine.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { CaptureService } from "../src/capture/capture.js";
import { FakeEmbedder } from "../src/testing/fakes.js";

function make() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-md-chunk-"));
  const db = openDatabase(dir);
  const store = new MemoryStore(db, new FakeEmbedder());
  const capture = new CaptureService(store, new FakeEmbedder());
  return { store, capture };
}

describe("captureMarkdown — long-note chunking (Phase 3)", () => {
  it("captures a long note as multiple obsidian/note chunk records", async () => {
    const { store, capture } = make();
    const note = `---\ntitle: Big\n---\n${"word ".repeat(1200)}`; // ~6000-char body

    const r = await capture.captureMarkdown({ path: "big.md", raw: note });

    expect(r.total).toBeGreaterThan(1);
    expect(r.insertedCount).toBe(r.total);
    expect(r.inserted).toBe(true);

    const recs = store.getPendingExperienceRecords().filter((p) => p.source === "obsidian");
    expect(recs).toHaveLength(r.total);
    expect(recs.every((x) => x.type === "note")).toBe(true);
    expect(recs.every((x) => typeof x.payload["chunk_index"] === "number")).toBe(true);
    expect(recs.every((x) => x.text.startsWith("Big\n\n"))).toBe(true);
  });

  it("keeps a short note as a single record", async () => {
    const { capture } = make();
    const r = await capture.captureMarkdown({ path: "small.md", raw: "# Hi\n\nshort body" });
    expect(r.total).toBe(1);
    expect(r.inserted).toBe(true);
  });

  it("keeps a medium note (within the defer threshold) as a single record", async () => {
    const { capture } = make();
    const r = await capture.captureMarkdown({ path: "mid.md", raw: "x".repeat(1500) });
    expect(r.total).toBe(1); // 1500 < 2048 threshold → not chunked, no churn
  });

  it("dedups an unchanged long note on re-scan", async () => {
    const { capture } = make();
    const note = `# Big\n\n${"word ".repeat(1200)}`;
    const first = await capture.captureMarkdown({ path: "big.md", raw: note });
    const again = await capture.captureMarkdown({ path: "big.md", raw: note });
    expect(again.inserted).toBe(false);
    expect(again.insertedCount).toBe(0);
    expect(again.total).toBe(first.total);
  });
});
