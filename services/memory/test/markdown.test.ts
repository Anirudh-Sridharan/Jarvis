/**
 * Tests for the markdown / Obsidian capture adapter: frontmatter, inline tags,
 * wikilinks, record building, and content-hash dedup on re-capture.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarkdownNote, buildMarkdownRecord } from "../src/capture/adapters/markdown.js";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { CaptureService } from "../src/capture/capture.js";
import { FakeEmbedder } from "../src/testing/fakes.js";

const NOTE = `---
title: Project Phoenix
tags: [work, planning]
status: active
---

# Kickoff

Met with [[Alice]] about [[Project Phoenix|the project]]. Action items #todo #work.
`;

describe("parseMarkdownNote", () => {
  it("extracts frontmatter, body, tags, and wikilinks", () => {
    const p = parseMarkdownNote(NOTE);
    expect(p.title).toBe("Project Phoenix");
    expect(p.frontmatter["status"]).toBe("active");
    expect(p.tags.sort()).toEqual(["planning", "todo", "work"]);
    expect(p.links.sort()).toEqual(["Alice", "Project Phoenix"]);
    expect(p.body).toContain("# Kickoff");
    expect(p.body).not.toContain("title: Project Phoenix");
  });

  it("handles a note with no frontmatter", () => {
    const p = parseMarkdownNote("Just a #quick thought about [[Bob]].");
    expect(p.frontmatter).toEqual({});
    expect(p.tags).toEqual(["quick"]);
    expect(p.links).toEqual(["Bob"]);
  });
});

describe("buildMarkdownRecord", () => {
  it("builds an obsidian-sourced note record with tag/link entities", () => {
    const rec = buildMarkdownRecord({ path: "notes/phoenix.md", raw: NOTE, mtime: "2026-06-10T09:00:00Z" });
    expect(rec.source).toBe("obsidian");
    expect(rec.type).toBe("note");
    expect(rec.timestamp).toBe("2026-06-10T09:00:00Z");
    expect(rec.text).toContain("Project Phoenix");
    const values = rec.entities.map((e) => e.value).sort();
    expect(values).toEqual(["Alice", "Project Phoenix", "planning", "todo", "work"]);
    expect(rec.provenance.source_id).toBe("notes/phoenix.md");
  });

  it("falls back to the filename stem when no title frontmatter", () => {
    const rec = buildMarkdownRecord({ path: "ideas/Big Idea.md", raw: "no fm here" });
    expect(rec.text.startsWith("Big Idea")).toBe(true);
  });
});

describe("CaptureService.captureMarkdown - dedup", () => {
  it("captures once, drops an unchanged re-scan, re-captures on edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-md-test-"));
    const db = openDatabase(dir);
    const store = new MemoryStore(db, new FakeEmbedder());
    const capture = new CaptureService(store, new FakeEmbedder());

    const first = await capture.captureMarkdown({ path: "a.md", raw: NOTE });
    expect(first.inserted).toBe(true);

    // Same content again → duplicate, dropped.
    const again = await capture.captureMarkdown({ path: "a.md", raw: NOTE });
    expect(again.inserted).toBe(false);

    // Edited content at the same path → re-captured (new content hash).
    const edited = await capture.captureMarkdown({ path: "a.md", raw: NOTE + "\nMore notes." });
    expect(edited.inserted).toBe(true);
  });
});
