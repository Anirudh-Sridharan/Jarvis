/**
 * Tests for the upgraded REFLECT stage: insights are grounded in the facts they
 * draw on (evidenceFactIds), made retrievable (indexed as episodes), and deduped
 * across consolidation passes.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { ConsolidationService } from "../src/consolidation/consolidation.js";
import { RetrievalService } from "../src/retrieval/retrieval.js";
import { CaptureService } from "../src/capture/capture.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";

const INSIGHT_TEXT = "User consistently prefers TypeScript across projects";

function makeKit() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-reflect-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const llm = new FakeLlm();
  // Force the REFLECT stage to emit a known insight (its text overlaps the
  // FakeLlm-extracted fact "User prefers TypeScript", so evidence should link).
  llm.addOverride(
    "meaningful patterns, trends, or insights",
    JSON.stringify([{ text: INSIGHT_TEXT, kind: "preference", importance: 7 }]),
  );
  const capture = new CaptureService(store, embedder);
  const consolidation = new ConsolidationService(store, llm, embedder);
  const retrieval = new RetrievalService(store, embedder);
  return { store, consolidation, capture, retrieval };
}

describe("REFLECT - grounded, retrievable insights", () => {
  it("links insights to evidence facts and indexes them for retrieval", async () => {
    const { store, consolidation, capture, retrieval } = makeKit();

    await capture.captureNote({ text: "I prefer TypeScript over Python", noteId: "n1" });
    const result = await consolidation.run("manual");

    expect(result.run.counts.insightsGenerated).toBe(1);

    // The insight is grounded: it cites the fact(s) it drew on.
    const insights = store.getRecentInsights(10);
    expect(insights).toHaveLength(1);
    expect(insights[0]?.text).toBe(INSIGHT_TEXT);
    expect(insights[0]?.evidenceFactIds.length).toBeGreaterThanOrEqual(1);

    // The insight is retrievable — it was indexed into the searchable graph.
    const hits = await retrieval.retrieve("TypeScript preference", { k: 10 });
    expect(hits.some((h) => h.text === INSIGHT_TEXT)).toBe(true);
  });

  it("dedups the same insight across consolidation passes", async () => {
    const { store, consolidation, capture } = makeKit();

    await capture.captureNote({ text: "I prefer TypeScript over Python", noteId: "n1" });
    const first = await consolidation.run("manual");
    expect(first.run.counts.insightsGenerated).toBe(1);

    // A second pass that would surface the same insight must not duplicate it.
    await capture.captureNote({ text: "Still loving TypeScript these days", noteId: "n2" });
    const second = await consolidation.run("manual");
    expect(second.run.counts.insightsGenerated).toBe(0);

    expect(store.getRecentInsights(10)).toHaveLength(1);
  });
});
