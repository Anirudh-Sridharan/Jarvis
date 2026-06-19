/**
 * Obsidian / markdown vault ingest (second-brain capture breadth).
 *
 * Walks a vault directory for `.md` files and captures each as a memory note
 * via captureMarkdown. Deterministic and idempotent — capture dedups on the
 * note's content hash, so re-scanning an unchanged vault drops as duplicates
 * and edited notes are re-captured. Consolidation (the existing scheduler, or
 * POST /consolidate) then promotes them into the searchable graph.
 *
 * This is the live (filesystem) layer; the markdown PARSING lives in the leaf
 * @jarvis/memory package, which never touches the filesystem.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { MemorySystem } from "@jarvis/memory";

export interface VaultIngestResult {
  scanned: number;
  captured: number;
  duplicates: number;
  errors: number;
}

export interface VaultIngestDeps {
  memory: Pick<MemorySystem, "capture">;
  vaultDir: string;
}

export async function runVaultIngest(deps: VaultIngestDeps): Promise<VaultIngestResult> {
  const res: VaultIngestResult = { scanned: 0, captured: 0, duplicates: 0, errors: 0 };
  const files = await collectMarkdownFiles(deps.vaultDir);

  for (const file of files) {
    res.scanned++;
    try {
      const raw = await readFile(file, "utf8");
      if (!raw.trim()) continue; // skip empty notes
      const st = await stat(file);
      const { inserted } = await deps.memory.capture.captureMarkdown({
        path: relative(deps.vaultDir, file),
        raw,
        mtime: new Date(st.mtimeMs).toISOString(),
      });
      if (inserted) res.captured++;
      else res.duplicates++;
    } catch {
      res.errors++;
    }
  }

  return res;
}

/** Recursively collect `.md` files, skipping dot-directories (.obsidian/.git/.trash). */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // .obsidian, .git, .trash, …
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        out.push(full);
      }
    }
  }

  await walk(dir);
  out.sort(); // deterministic order
  return out;
}
