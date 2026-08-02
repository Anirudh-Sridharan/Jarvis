/**
 * External capture tests (feature 9 → 3 bridge intake):
 *   - buildExternalRecord shape + content-hash dedup key
 *   - captureExternal inserts, dedups identical passes, re-captures on change
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystem, buildExternalRecord, type MemorySystem } from "../src/index.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";

let dataDir: string;
let memory: MemorySystem;
// Held at module scope (not just inside createMemorySystem's config) so a
// test can register llm.addOverride(...) after the system is already wired.
let llm: FakeLlm;

beforeEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = mkdtempSync(join(tmpdir(), "jarvis-external-capture-"));
  llm = new FakeLlm();
  memory = createMemorySystem({
    embedder: new FakeEmbedder(),
    llm,
    dataDir,
  });
});

const eventOpts = {
  source: "gcal" as const,
  type: "calendar_event" as const,
  nativeId: "evt-1",
  text: "Calendar event: Standup — 2026-06-11T10:00Z..10:30Z",
  timestamp: "2026-06-11T10:00:00Z",
  content: { etag: '"v1"', start: "2026-06-11T10:00:00Z" },
};

describe("buildExternalRecord", () => {
  it("builds a well-formed record with content-hashed dedup key", () => {
    const r = buildExternalRecord(eventOpts);
    expect(r.source).toBe("gcal");
    expect(r.type).toBe("calendar_event");
    expect(r.actor).toBe("gcal");
    expect(r.consolidation_pending).toBe(true);
    expect(r.dedup_key).toMatch(/^gcal:evt-1:sha256:/);
    // same content → same dedup key; changed content → different
    expect(buildExternalRecord(eventOpts).dedup_key).toBe(r.dedup_key);
    expect(
      buildExternalRecord({ ...eventOpts, content: { etag: '"v2"' } }).dedup_key,
    ).not.toBe(r.dedup_key);
  });
});

describe("captureExternal", () => {
  it("inserts once and drops identical re-captures", async () => {
    const first = await memory.capture.captureExternal(eventOpts);
    const second = await memory.capture.captureExternal(eventOpts);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it("re-captures when the content changes (e.g. event moved)", async () => {
    await memory.capture.captureExternal(eventOpts);
    const moved = await memory.capture.captureExternal({
      ...eventOpts,
      text: "Calendar event: Standup — 2026-06-11T11:00Z..11:30Z",
      content: { etag: '"v2"', start: "2026-06-11T11:00:00Z" },
    });
    expect(moved.inserted).toBe(true);
  });
});

// This file completes SC3's hermetic capture-surface coverage: chat/note
// (capture.test.ts), the MEM-01 pending path (retrieval.test.ts), documents
// (document-capture.test.ts), email (email-capture.test.ts), and here,
// external/connector capture. The @jarvis/core ingest surfaces (vault, files,
// email ingest, ingest bridge) are covered by plan 13-03. iMessage capture is
// explicitly deferred to Phase 10 — Phase 9 built only the hermetic
// orchestrator/safety logic, with no real chat.db capture surface to
// force-consolidate yet; do not stub one to satisfy this checklist.
describe("captureExternal - MEM-06 force-consolidate -> retrieve -> content assert", () => {
  it("a captured external/connector item is recallable by content after force-consolidation", async () => {
    const marker = "eval-canary-external-8817";
    // FakeLlm's default extraction is a fixed "User prefers TypeScript" fact —
    // the record's own literal text never reaches the graph unless an
    // override is registered on a distinctive substring of its body.
    // reflectInsights() also embeds the same raw record text under "Recent
    // experiences:", so suppress that prompt explicitly (checked first) to
    // avoid a duplicate episode via indexInsightAsEpisode().
    llm.addOverride("Recent experiences:", "[]");
    llm.addOverride(
      marker,
      JSON.stringify([
        {
          entity: "self",
          predicate: "mentions",
          object: marker,
          text: `Calendar event mentions ${marker}`,
          confidence: 0.9,
        },
      ]),
    );

    const captured = await memory.capture.captureExternal({
      ...eventOpts,
      nativeId: "evt-mem06-1",
      text: `Calendar event: Standup with ${marker} — 2026-06-11T10:00Z..10:30Z`,
    });
    expect(captured.inserted).toBe(true);

    const result = await memory.consolidation.run("manual");
    expect(result.run.status).toBe("completed");
    expect(result.run.errors).toHaveLength(0);

    const results = await memory.retrieval.retrieve(`${marker} standup`, { k: 5 });
    const hit = results.find((r) => r.text.includes(marker));
    expect(hit).toBeDefined();
  });
});
