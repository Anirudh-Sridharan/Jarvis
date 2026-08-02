/**
 * SC1 — hermetic seeded-fact recall@k/MRR harness (MEM-05, phase 13).
 *
 * Honest scope of this tier: this harness measures the DETERMINISTIC
 * fusion/ranking/MMR pipeline's correctness under literal-token overlap
 * (BM25-dominant), NOT real semantic-embedding quality. FakeEmbedder.embed()
 * is SHA-256(literal text) spread into a unit vector — it is not a semantic
 * embedding, so two paraphrases of the same fact produce uncorrelated
 * vectors. Plan 13-04's live CLI probe (`npm run eval:recall`), which runs
 * against the real GatewayEmbedder, is the only tier that can speak to true
 * semantic recall quality.
 *
 * Every measurement in this file flows through the real, unmodified
 * RetrievalService.retrieve() — never a parallel eval-only ranking path.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { RetrievalService } from "../src/retrieval/retrieval.js";
import { FakeEmbedder } from "../src/testing/fakes.js";
import { evaluateRecall, type RecallJudgment } from "../src/retrieval/recallMetrics.js";
import {
  TARGET_FACTS,
  DISTRACTOR_FACTS,
  QUERIES,
  ABSENT_TOPIC_QUERIES,
} from "./fixtures/seededFacts.js";

const EVAL_K = 8; // matches RetrievalService's DEFAULT_K

// Observed on the harness's first run (2026-08-02): recallAtK=1, mrr=1 over
// the 10 seeded queries against the real RetrievalService/FakeEmbedder pair.
// Locked threshold = observed value floored to two decimals minus a 0.05
// safety margin, clamped at a floor of 0.5 (a threshold below 0.5 would mean
// the fixtures need redesign, not a looser bar).
const SC1_RECALL_AT_K_BASELINE = 0.95;
const SC1_MRR_BASELINE = 0.95;

function makeRetrieval() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-recall-eval-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  const retrieval = new RetrievalService(store, embedder);
  return { store, retrieval, embedder };
}

describe("Recall eval - corpus is non-trivial", () => {
  it("has 10 target facts", () => {
    expect(TARGET_FACTS.length).toBe(10);
  });

  it("has at least 4x as many distractors as targets", () => {
    expect(DISTRACTOR_FACTS.length).toBeGreaterThanOrEqual(4 * TARGET_FACTS.length);
  });

  it("has one query per target", () => {
    expect(QUERIES.length).toBe(TARGET_FACTS.length);
  });

  it("total corpus size exceeds the eval k (a corpus that fits inside k proves nothing)", () => {
    const totalSize = TARGET_FACTS.length + DISTRACTOR_FACTS.length;
    expect(totalSize).toBeGreaterThan(EVAL_K);
  });
});

describe("Recall eval - hermetic baseline (SC1)", () => {
  let seedMap: Map<string, string>;
  let retrieval: RetrievalService;

  beforeAll(async () => {
    const setup = makeRetrieval();
    retrieval = setup.retrieval;
    seedMap = new Map<string, string>();

    for (const fact of [...TARGET_FACTS, ...DISTRACTOR_FACTS]) {
      const episode = await setup.store.upsertEpisode({
        text: fact.text,
        occurredAt: fact.occurredAt,
        provenance: { source: "note", sourceId: fact.sourceId, confidence: 0.9 },
      });
      seedMap.set(fact.sourceId, episode.id);
    }
  });

  it("meets the locked recall@k and MRR baseline over the seeded corpus", async () => {
    const judgments: RecallJudgment[] = [];
    for (const q of QUERIES) {
      const targetMemoryId = seedMap.get(q.sourceId);
      expect(targetMemoryId).toBeDefined();
      const results = await retrieval.retrieve(q.query, { k: EVAL_K });
      judgments.push({
        query: q.query,
        targetMemoryId: targetMemoryId!,
        retrieved: results.map((r) => ({ memoryId: r.memoryId, rank: r.rank })),
      });
    }

    const result = evaluateRecall(judgments);
    expect(result.recallAtK).toBeGreaterThanOrEqual(SC1_RECALL_AT_K_BASELINE);
    expect(result.mrr).toBeGreaterThanOrEqual(SC1_MRR_BASELINE);
  });
});

describe("Recall eval - negative control is structurally overlap-free (WR-04)", () => {
  // Same tokenizer semantics as the BM25 index (services/memory/src/search/
  // bm25.ts): lowercase, split on non-alphanumeric, no stemming, no
  // stopwords. Kept in exact sync so "zero token overlap" here means zero
  // BM25-relevant overlap there.
  const tokenize = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);

  it("no ABSENT_TOPIC_QUERIES token appears in ANY seeded fixture text", () => {
    const corpusTokens = new Set<string>();
    for (const fact of [...TARGET_FACTS, ...DISTRACTOR_FACTS]) {
      for (const tok of tokenize(fact.text)) corpusTokens.add(tok);
    }

    for (const query of ABSENT_TOPIC_QUERIES) {
      const collisions = tokenize(query).filter((tok) => corpusTokens.has(tok));
      // Structural enforcement of the fixture-file claim: the invariant is
      // recomputed from the actual texts, not asserted in prose — an edit to
      // either side that introduces a shared token fails HERE with the
      // offending tokens named, instead of leaving the negative control one
      // hash coincidence away from meaninglessness.
      expect(collisions, `query "${query}" shares tokens [${collisions.join(", ")}] with the seeded corpus`).toEqual([]);
    }
  });
});

describe("Recall eval - negative control", () => {
  it("no target memoryId surfaces for any absent-topic query (recall is provably 0)", async () => {
    const setup = makeRetrieval();
    const seedMap = new Map<string, string>();
    for (const fact of [...TARGET_FACTS, ...DISTRACTOR_FACTS]) {
      const episode = await setup.store.upsertEpisode({
        text: fact.text,
        occurredAt: fact.occurredAt,
        provenance: { source: "note", sourceId: fact.sourceId, confidence: 0.9 },
      });
      seedMap.set(fact.sourceId, episode.id);
    }

    // For every absent-topic query, run the REAL retrieval pipeline once,
    // then check whether ANY of the 10 real target memoryIds leaked into
    // that query's results. This is a behavioral assertion against actual
    // retrieval output (not a sentinel id that trivially can't be found) —
    // a broken pipeline that returns everything for every query would fail
    // this by returning a nonzero recallAtK.
    const judgments: RecallJudgment[] = [];
    for (const absentQuery of ABSENT_TOPIC_QUERIES) {
      const results = await setup.retrieval.retrieve(absentQuery, { k: EVAL_K });
      const retrieved = results.map((r) => ({ memoryId: r.memoryId, rank: r.rank }));
      for (const target of TARGET_FACTS) {
        judgments.push({
          query: absentQuery,
          targetMemoryId: seedMap.get(target.sourceId)!,
          retrieved,
        });
      }
    }

    const result = evaluateRecall(judgments);
    expect(result.recallAtK).toBe(0);
  });
});

describe("Recall eval - ranking is load-bearing", () => {
  it("a target's rank is within [0, EVAL_K) and the result count never exceeds EVAL_K", async () => {
    const setup = makeRetrieval();
    const seedMap = new Map<string, string>();
    for (const fact of [...TARGET_FACTS, ...DISTRACTOR_FACTS]) {
      const episode = await setup.store.upsertEpisode({
        text: fact.text,
        occurredAt: fact.occurredAt,
        provenance: { source: "note", sourceId: fact.sourceId, confidence: 0.9 },
      });
      seedMap.set(fact.sourceId, episode.id);
    }

    const q = QUERIES[0]!;
    const targetMemoryId = seedMap.get(q.sourceId)!;
    const results = await setup.retrieval.retrieve(q.query, { k: EVAL_K });

    expect(results.length).toBeLessThanOrEqual(EVAL_K);
    const hit = results.find((r) => r.memoryId === targetMemoryId);
    expect(hit).toBeDefined();
    expect(typeof hit!.rank).toBe("number");
    expect(hit!.rank).toBeGreaterThanOrEqual(0);
    expect(hit!.rank).toBeLessThan(EVAL_K);
  });
});
