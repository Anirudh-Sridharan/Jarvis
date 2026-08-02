/**
 * Tests for the Obsidian/markdown vault ingester.
 *
 * Builds a temp vault (with a nested note, a dot-dir to skip, and an empty
 * file), ingests it into a real (fake-backed) MemorySystem, and checks counts,
 * dot-dir/empty skipping, and idempotent dedup on re-run.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";
import { runVaultIngest } from "../src/memory/vaultIngest.js";

function makeVault() {
  const vault = mkdtempSync(join(tmpdir(), "jarvis-vault-"));
  writeFileSync(join(vault, "root.md"), "# Root note\n\nAbout [[Topic]] #idea");
  mkdirSync(join(vault, "sub"));
  writeFileSync(join(vault, "sub", "nested.md"), "---\ntitle: Nested\n---\nbody #work");
  writeFileSync(join(vault, "empty.md"), "   \n");
  writeFileSync(join(vault, "notes.txt"), "not markdown");
  // A dot-dir (e.g. .obsidian config) must be skipped entirely.
  mkdirSync(join(vault, ".obsidian"));
  writeFileSync(join(vault, ".obsidian", "config.md"), "# should be skipped");
  return vault;
}

function makeMemory(llm: FakeLlm = new FakeLlm()) {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-vault-mem-"));
  return createMemorySystem({ embedder: new FakeEmbedder(), llm, dataDir });
}

describe("runVaultIngest", () => {
  it("ingests markdown files, skipping dot-dirs, non-md, and empty notes", async () => {
    const vaultDir = makeVault();
    const memory = makeMemory();

    const r = await runVaultIngest({ memory, vaultDir });

    // root.md + sub/nested.md + empty.md = 3 .md files scanned; empty.md is
    // skipped (not captured), .obsidian and notes.txt are never collected.
    expect(r.scanned).toBe(3);
    expect(r.captured).toBe(2);
    expect(r.duplicates).toBe(0);
    expect(r.errors).toBe(0);

    // The captured notes are journaled and pending consolidation.
    const pending = memory.store.getPendingExperienceRecords();
    expect(pending.filter((p) => p.source === "obsidian")).toHaveLength(2);
  });

  it("is idempotent — a re-scan of an unchanged vault captures nothing new", async () => {
    const vaultDir = makeVault();
    const memory = makeMemory();

    await runVaultIngest({ memory, vaultDir });
    const second = await runVaultIngest({ memory, vaultDir });

    expect(second.scanned).toBe(3); // includes the skipped empty note
    expect(second.captured).toBe(0);
    expect(second.duplicates).toBe(2);
  });

  it("returns zero counts for a missing/empty directory", async () => {
    const memory = makeMemory();
    const r = await runVaultIngest({ memory, vaultDir: join(tmpdir(), "does-not-exist-xyz") });
    expect(r).toEqual({ scanned: 0, captured: 0, duplicates: 0, errors: 0 });
  });
});

describe("runVaultIngest - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  it("promotes an ingested note into the retrievable graph after consolidation", async () => {
    const marker = "eval-canary-vault-note1";
    const vaultDir = mkdtempSync(join(tmpdir(), "jarvis-vault-mem06-"));
    writeFileSync(join(vaultDir, "canary.md"), `# Canary\n\nThis note mentions ${marker} for retrieval testing.`);

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

    const r = await runVaultIngest({ memory, vaultDir });
    expect(r.captured).toBe(1);
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
