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

function makeMemory() {
  const dataDir = mkdtempSync(join(tmpdir(), "jarvis-vault-mem-"));
  return createMemorySystem({ embedder: new FakeEmbedder(), llm: new FakeLlm(), dataDir });
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
