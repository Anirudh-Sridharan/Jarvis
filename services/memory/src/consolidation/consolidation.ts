/**
 * Nightly memory consolidation (feature 6) — 9-stage pipeline.
 *
 * Stage orchestration is deterministic TS/Node.
 * AI stages (2: EXTRACT, 3: REFLECT, 6: SCORE IMPORTANCE, 7: PROCEDURAL)
 * use the injected LlmClient. Embeddings use the injected Embedder.
 *
 * The pipeline is idempotent: if called twice on the same window, the second
 * run finds no pending records and fast-exits with zero counts.
 *
 * Stages:
 *  1. GATHER   — select pending records, create ConsolidationRun
 *  2. EXTRACT  — LLM → ExtractedFact[]
 *  3. REFLECT  — LLM → Insight[]
 *  4. RESOLVE  — temporal validity, supersession, dedup
 *  5. FORGET   — decay scoring → evict low-value facts
 *  6. IMPORTANCE — LLM salience 1-10 (+ clamp)
 *  7. PROCEDURAL — update "how I like to work" block
 *  8. EMBED    — batch-embed deferred experience records
 *  9. BRIEFING — clear flags, finalize run
 */

import type {
  LlmClient,
  Embedder,
  ConsolidationRun,
  ExperienceRecord,
  ExtractedFact,
  Insight,
  Fact,
} from "../types.js";
import type { MemoryStore } from "../store/memoryStore.js";
import { newId } from "../db/database.js";
import { extractFacts } from "./extract.js";
import { resolveFact } from "./contradictions.js";
import { computeForgetDecisions, applyForgetDecisions } from "./forget.js";
import { updateProceduralBlock } from "./procedural.js";

export interface ConsolidationResult {
  run: ConsolidationRun;
  briefing: {
    insights: Insight[];
    newFacts: Fact[];
    invalidatedFactIds: string[];
    proceduralUpdated: boolean;
  };
}

const EMPTY_COUNTS = () => ({
  recordsProcessed: 0,
  factsExtracted: 0,
  factsMerged: 0,
  factsInvalidated: 0,
  factsForgotten: 0,
  factsCompressed: 0,
  insightsGenerated: 0,
  embeddingsWritten: 0,
});

export class ConsolidationService {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly embedder: Embedder,
  ) {}

  async run(trigger: "scheduler" | "manual" = "manual"): Promise<ConsolidationResult> {
    const now = new Date().toISOString();
    const runId = newId();

    // ── Stage 1: GATHER ────────────────────────────────────────────────────
    const pending = this.store.getPendingExperienceRecords();

    const run: ConsolidationRun = {
      id: runId,
      startedAt: now,
      status: "running",
      stage: 1,
      windowStart: pending.length > 0 ? pending[0]!.ingested_at : now,
      windowEnd: now,
      inputRecordIds: pending.map((r) => r.id),
      counts: EMPTY_COUNTS(),
      errors: [],
      trigger,
    };
    this.store.insertConsolidationRun(run);

    if (pending.length === 0) {
      // Fast-exit: nothing to consolidate
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.stage = 9;
      this.store.updateConsolidationRun(runId, run);
      return { run, briefing: { insights: [], newFacts: [], invalidatedFactIds: [], proceduralUpdated: false } };
    }

    run.counts.recordsProcessed = pending.length;
    this.checkpoint(run, 1);

    // ── Stage 2: EXTRACT ──────────────────────────────────────────────────
    let extractedFacts: ExtractedFact[] = [];
    // Only records whose extraction succeeded may be marked consolidated in
    // stage 9 — failed records stay pending for the next run.
    let extractionProcessedIds = new Set<string>();
    try {
      const extraction = await extractFacts(pending, this.llm, runId);
      extractedFacts = extraction.facts;
      extractionProcessedIds = new Set(extraction.processedRecordIds);
      for (const failure of extraction.failures) {
        run.errors.push({ stage: 2, message: failure.message, recordId: failure.recordId });
      }
      run.counts.factsExtracted = extractedFacts.length;
    } catch (err) {
      run.errors.push({ stage: 2, message: String(err) });
    }
    this.checkpoint(run, 2);

    // ── Stage 3: REFLECT ──────────────────────────────────────────────────
    const insights: Insight[] = [];
    try {
      const reflectInsights = await this.reflectInsights(pending, runId);
      insights.push(...reflectInsights);
      for (const ins of insights) {
        this.store.insertInsight(ins);
      }
      run.counts.insightsGenerated = insights.length;
    } catch (err) {
      run.errors.push({ stage: 3, message: String(err) });
    }
    this.checkpoint(run, 3);

    // ── Stage 4: RESOLVE ──────────────────────────────────────────────────
    const newFacts: Fact[] = [];
    const allInvalidatedIds: string[] = [];

    for (const extracted of extractedFacts) {
      try {
        const result = await resolveFact(extracted, this.store, this.llm);
        allInvalidatedIds.push(...result.invalidatedIds);
        const fact = this.store.getFactById(result.factId);
        if (fact) newFacts.push(fact);
        if (result.invalidatedIds.length > 0) run.counts.factsInvalidated += result.invalidatedIds.length;
      } catch (err) {
        run.errors.push({ stage: 4, message: String(err), recordId: extracted.sourceRecordId });
      }
    }
    this.checkpoint(run, 4);

    // ── Stage 5: FORGET ───────────────────────────────────────────────────
    try {
      const decisions = computeForgetDecisions(this.store, Date.now());
      const { evicted, compressed } = await applyForgetDecisions(decisions, this.store, Date.now(), this.llm);
      run.counts.factsForgotten = evicted;
      run.counts.factsCompressed = compressed;
    } catch (err) {
      run.errors.push({ stage: 5, message: String(err) });
    }
    this.checkpoint(run, 5);

    // ── Stage 6: IMPORTANCE ───────────────────────────────────────────────
    try {
      for (const fact of newFacts) {
        const importance = await this.scoreImportance(fact);
        const db = (this.store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
        db.prepare(`UPDATE facts SET importance = ? WHERE id = ?`).run(importance, fact.id);
      }
    } catch (err) {
      run.errors.push({ stage: 6, message: String(err) });
    }
    this.checkpoint(run, 6);

    // ── Stage 7: PROCEDURAL BLOCK ─────────────────────────────────────────
    let proceduralUpdated = false;
    try {
      proceduralUpdated = await updateProceduralBlock(this.store, this.llm, newFacts);
    } catch (err) {
      run.errors.push({ stage: 7, message: String(err) });
    }
    this.checkpoint(run, 7);

    // ── Stage 8: DEFERRED EMBED ───────────────────────────────────────────
    try {
      const deferredRecords = pending.filter((r) => r.embed_state === "deferred");
      if (deferredRecords.length > 0) {
        const texts = deferredRecords.map((r) => r.text);
        const vectors = await this.embedder.embed(texts);
        let written = 0;
        for (let i = 0; i < deferredRecords.length; i++) {
          const r = deferredRecords[i]!;
          const vec = vectors[i];
          if (!vec) continue; // no vector returned — stays deferred
          this.store.upsertEmbedding(r.id, "experience", vec);
          this.store.updateExperienceEmbedState(r.id, "done");
          written++;
        }
        run.counts.embeddingsWritten = written;
      }
    } catch (err) {
      run.errors.push({ stage: 8, message: String(err) });
    }
    this.checkpoint(run, 8);

    // ── Stage 9: BRIEFING PREP / CLEAR FLAGS ─────────────────────────────
    // Only clear records whose extraction succeeded; failed records stay
    // pending so they are retried by the next consolidation pass.
    for (const record of pending) {
      if (extractionProcessedIds.has(record.id)) {
        this.store.markExperienceConsolidated(record.id);
      }
    }
    const allProcessed = pending.every((r) => extractionProcessedIds.has(r.id));
    run.status = allProcessed ? "completed" : "partial";
    run.finishedAt = new Date().toISOString();
    run.stage = 9;
    this.store.updateConsolidationRun(runId, run);

    return {
      run,
      briefing: {
        insights,
        newFacts,
        invalidatedFactIds: allInvalidatedIds,
        proceduralUpdated,
      },
    };
  }

  private checkpoint(run: ConsolidationRun, stage: ConsolidationRun["stage"]): void {
    run.stage = stage;
    this.store.updateConsolidationRun(run.id, { stage, counts: run.counts, errors: run.errors });
  }

  private async reflectInsights(
    records: ExperienceRecord[],
    runId: string,
  ): Promise<Insight[]> {
    if (records.length === 0) return [];

    const bodySample = records
      .slice(0, 10)
      .map((r) => r.text.slice(0, 200))
      .join("\n---\n");

    const prompt = `Analyze these recent experiences and identify meaningful patterns, trends, or insights.
Return a JSON array of insights: [{"text": string, "kind": "pattern"|"trend"|"preference"|"anomaly", "importance": number 1-10}]
If no clear patterns, return [].

Experiences:
"""
${bodySample}
"""`;

    try {
      const raw = await this.llm.complete({ prompt, json: true });
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]) as Array<{
        text?: string;
        kind?: string;
        importance?: number;
      }>;
      return parsed
        .filter((i) => typeof i.text === "string" && i.text.length > 0)
        .map((i) => ({
          id: newId(),
          runId,
          text: i.text!,
          kind: (i.kind ?? "pattern") as Insight["kind"],
          evidenceFactIds: [],
          windowDays: 1,
          importance: i.importance ?? 5,
          surfacedInBriefing: false,
          createdAt: new Date().toISOString(),
        }));
    } catch {
      return [];
    }
  }

  private async scoreImportance(fact: Fact): Promise<number> {
    const prompt = `Rate the long-term importance of this fact on a scale of 1-10.
Fact: "${fact.text}"
1 = trivial/ephemeral, 10 = critical/permanent personal fact.
Reply with JSON: {"importance": number}`;

    try {
      const raw = await this.llm.complete({ prompt, json: true });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return fact.importance;
      const parsed = JSON.parse(match[0]) as { importance?: number };
      const suggested = parsed.importance ?? fact.importance;
      // Clamp to the 1–10 scale, then guard drift to ±3 of the prior importance.
      const clamped = Math.max(1, Math.min(10, Math.round(suggested)));
      return Math.max(fact.importance - 3, Math.min(fact.importance + 3, clamped));
    } catch {
      return fact.importance;
    }
  }
}
