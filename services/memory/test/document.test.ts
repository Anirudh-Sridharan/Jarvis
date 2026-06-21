/**
 * Tests for the document capture adapter: chunks-only records, doc_id grouping,
 * per-chunk dedup keys, title prefixing, and path-derived entities.
 */

import { describe, it, expect } from "vitest";
import { buildDocumentChunkRecords } from "../src/capture/adapters/document.js";

function tokens(n: number): string {
  return Array.from({ length: n }, (_, i) => `tok${String(i).padStart(3, "0")}`).join(" ");
}

const MULTI = { targetChars: 60, overlapChars: 0, minChars: 10 };

describe("buildDocumentChunkRecords", () => {
  it("emits one record per chunk with sequential indices and a shared count", () => {
    const recs = buildDocumentChunkRecords({
      path: "research/papers/attention.pdf",
      docId: "doc-abc",
      text: tokens(100),
      chunkOpts: MULTI,
    });
    expect(recs.length).toBeGreaterThan(1);
    recs.forEach((r, i) => {
      expect(r.source).toBe("files");
      expect(r.type).toBe("document");
      expect(r.actor).toBe("user");
      expect(r.payload["chunk_index"]).toBe(i);
      expect(r.payload["chunk_count"]).toBe(recs.length);
      expect(r.payload["doc_id"]).toBe("doc-abc");
      expect(r.payload["path"]).toBe("research/papers/attention.pdf");
    });
  });

  it("prefixes each chunk's text with the document title", () => {
    const recs = buildDocumentChunkRecords({
      path: "a/b/notes.txt",
      docId: "d1",
      title: "Quarterly Plan",
      text: tokens(100),
      chunkOpts: MULTI,
    });
    for (const r of recs) expect(r.text.startsWith("Quarterly Plan\n\n")).toBe(true);
  });

  it("uses mtime as the event timestamp", () => {
    const [rec] = buildDocumentChunkRecords({
      path: "x.txt",
      docId: "d2",
      text: "Hello world",
      mtime: "2026-06-01T08:00:00Z",
    });
    expect(rec!.timestamp).toBe("2026-06-01T08:00:00Z");
  });

  it("derives a single chunk for short text", () => {
    const recs = buildDocumentChunkRecords({ path: "x.txt", docId: "d3", text: "Hello world" });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.payload["chunk_index"]).toBe(0);
    expect(recs[0]!.payload["chunk_count"]).toBe(1);
  });

  it("gives each chunk a unique, deterministic dedup key", () => {
    const args = { path: "doc.txt", docId: "d4", text: tokens(100), chunkOpts: MULTI };
    const a = buildDocumentChunkRecords(args);
    const b = buildDocumentChunkRecords(args);
    const keysA = a.map((r) => r.dedup_key);
    expect(new Set(keysA).size).toBe(keysA.length); // unique across chunks
    expect(keysA).toEqual(b.map((r) => r.dedup_key)); // deterministic
    expect(a[0]!.provenance.source_id).toBe("doc.txt#0");
  });

  it("derives tag entities from the filename stem and parent folder", () => {
    const [rec] = buildDocumentChunkRecords({
      path: "research/papers/attention.pdf",
      docId: "d5",
      text: "Hello world",
    });
    const values = rec!.entities.map((e) => e.value);
    expect(rec!.entities.every((e) => e.kind === "tag")).toBe(true);
    expect(values).toContain("attention");
    expect(values).toContain("papers");
  });

  it("returns no records for empty text", () => {
    expect(buildDocumentChunkRecords({ path: "x.txt", docId: "d6", text: "   " })).toEqual([]);
  });
});
