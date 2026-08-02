/**
 * Tests for the local documents ingester (runFilesIngest).
 *
 * Builds a temp tree (text, nested markdown, a PDF via an injected fake parser,
 * an empty file, an unsupported type, and a dot-dir) and ingests it into a real
 * fake-backed MemorySystem. Verifies walk/skip semantics, multi-chunk capture,
 * the size cap, idempotent doc-level dedup, and a missing directory.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";
import { runFilesIngest } from "../src/memory/filesIngest.js";
import { extractText } from "../src/memory/extractText.js";

/** Real extraction dispatch, but PDFs resolve through a deterministic fake parser. */
const extract = (ext: string, bytes: Buffer, path: string) =>
  extractText(ext, bytes, path, { parsePdf: async () => ({ text: "PDF body about Jarvis", pages: 1 }) });

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-files-"));
  writeFileSync(join(dir, "root.txt"), "Hello world");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "notes.md"), "# Notes\n\nA short body.");
  writeFileSync(join(dir, "paper.pdf"), "%PDF-1.4 binary-ish");
  writeFileSync(join(dir, "empty.txt"), "   \n");
  writeFileSync(join(dir, "archive.zip"), "PK"); // unsupported ext
  mkdirSync(join(dir, ".hidden"));
  writeFileSync(join(dir, ".hidden", "secret.txt"), "should be skipped");
  return dir;
}

function makeMemory(llm: FakeLlm = new FakeLlm()) {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-files-mem-"));
  return createMemorySystem({ embedder: new FakeEmbedder(), llm, dataDir });
}

describe("runFilesIngest", () => {
  it("ingests supported docs, skipping dot-dirs, unsupported, and empty files", async () => {
    const dir = makeTree();
    const memory = makeMemory();

    const r = await runFilesIngest({ memory, dir, extract });

    // root.txt + sub/notes.md + paper.pdf + empty.txt = 4 supported files scanned;
    // archive.zip and .hidden/* are never collected.
    expect(r.scanned).toBe(4);
    expect(r.documents).toBe(3); // empty.txt extracts to nothing → skipped
    expect(r.chunks).toBe(3); // one chunk each
    expect(r.duplicates).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.errors).toBe(0);

    const pending = memory.store.getPendingExperienceRecords().filter((p) => p.source === "files");
    expect(pending).toHaveLength(3);
  });

  it("captures multiple chunks for a long document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-files-long-"));
    writeFileSync(join(dir, "long.txt"), "word ".repeat(700)); // ~3500 chars > default target
    const memory = makeMemory();

    const r = await runFilesIngest({ memory, dir, extract });

    expect(r.documents).toBe(1);
    expect(r.chunks).toBeGreaterThan(1);
  });

  it("skips files over the size cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-files-big-"));
    writeFileSync(join(dir, "big.txt"), "x".repeat(100));
    const memory = makeMemory();

    const r = await runFilesIngest({ memory, dir, extract, maxBytes: 10 });

    expect(r.scanned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.documents).toBe(0);
  });

  it("is idempotent — a re-scan of unchanged files captures nothing new", async () => {
    const dir = makeTree();
    const memory = makeMemory();

    await runFilesIngest({ memory, dir, extract });
    const second = await runFilesIngest({ memory, dir, extract });

    expect(second.scanned).toBe(4);
    expect(second.documents).toBe(0);
    expect(second.chunks).toBe(0);
    expect(second.duplicates).toBe(3); // doc-level skip on unchanged content
    expect(second.skipped).toBe(1);
  });

  it("returns zero counts for a missing directory", async () => {
    const memory = makeMemory();
    const r = await runFilesIngest({ memory, dir: join(tmpdir(), "does-not-exist-xyz"), extract });
    expect(r).toEqual({ scanned: 0, documents: 0, chunks: 0, duplicates: 0, skipped: 0, errors: 0 });
  });
});

describe("runFilesIngest - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  it("promotes an ingested document into the retrievable graph after consolidation", async () => {
    const marker = "eval-canary-files-doc1";
    const dir = mkdtempSync(join(tmpdir(), "jarvis-files-mem06-"));
    writeFileSync(join(dir, "canary.txt"), `Document body mentioning ${marker} for retrieval testing.`);

    // FakeLlm's default extraction is a fixed "User prefers TypeScript" result,
    // and consolidation never copies a record's literal text into the graph —
    // so without this override the marker cannot possibly come back, and the
    // test would be measuring the fake, not the pipeline.
    const llm = new FakeLlm();
    // reflectInsights()'s prompt also embeds a raw sample of the same pending
    // record text (under "Recent experiences:"), so the marker override would
    // otherwise ALSO match the reflection call and mint a duplicate
    // marker-bearing EPISODE via indexInsightAsEpisode(). Suppress reflection
    // explicitly — FakeLlm checks overrides in insertion order, so this must
    // be registered FIRST to win for the reflect prompt; the extraction
    // prompt never contains "Recent experiences:", so the marker override
    // below still matches it (WR-03, mirroring the memory-side retrofits).
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        { entity: "self", predicate: "mentions", object: "canary", text: `Canary note: ${marker}`, confidence: 0.9 },
      ]),
    );
    const memory = makeMemory(llm);

    const r = await runFilesIngest({ memory, dir, extract });
    expect(r.documents).toBe(1);
    expect(r.errors).toBe(0);

    const result = await memory.consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.errors.length).toBe(0);
    expect(result.run.counts.recordsProcessed).toBeGreaterThanOrEqual(1);

    // kind === "fact" pins the marker to the extract→resolve→fact promotion
    // path specifically — a reflection-minted episode (or a still-pending
    // record) satisfying a bare text-includes check would prove only that the
    // marker reached the graph via SOME path (WR-03).
    const hits = await memory.retrieval.retrieve(marker, { k: 5 });
    const hit = hits.find((h) => h.text.includes(marker));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("fact");
  });
});
