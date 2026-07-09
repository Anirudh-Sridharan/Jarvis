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
  Clock,
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
import { isRetryEligible, computeNextRetryAt, DEAD_LETTER_THRESHOLD } from "./retryPolicy.js";

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
  conflictsFlagged: 0,
});

export class ConsolidationService {
  constructor(
    private readonly store: MemoryStore,
    private readonly llm: LlmClient,
    private readonly embedder: Embedder,
    /** MEM-02: injected for deterministic retry/backoff bookkeeping. Defaults to the real system clock. */
    private readonly clock: Clock = { now: () => Date.now() },
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

    // MEM-02: split pending records into those eligible for extraction now vs
    // those still inside a prior failure's backoff window. getPendingExperienceRecords()
    // itself is untouched (still returns ALL non-dead-lettered pending records,
    // including backoff-waiting ones) so ConsolidationScheduler's quiet/burst
    // cadence — which reads pending.length — keeps working unmodified.
    const nowMs = this.clock.now();
    const eligible = pending.filter((r) => isRetryEligible(r.nextRetryAt, nowMs));

    if (eligible.length === 0) {
      // Fast-exit: everything pending is backoff-blocked from a prior failure.
      // Zero LLM calls — neither stage 2 (EXTRACT) nor stage 3 (REFLECT) runs.
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.stage = 9;
      this.store.updateConsolidationRun(runId, run);
      return { run, briefing: { insights: [], newFacts: [], invalidatedFactIds: [], proceduralUpdated: false } };
    }

    // ── Stage 2: EXTRACT ──────────────────────────────────────────────────
    let extractedFacts: ExtractedFact[] = [];
    // Only records whose extraction succeeded may be marked consolidated in
    // stage 9 — failed records stay pending for the next run.
    let extractionProcessedIds = new Set<string>();
    try {
      const extraction = await extractFacts(eligible, this.llm, runId);
      extractedFacts = extraction.facts;
      extractionProcessedIds = new Set(extraction.processedRecordIds);
      for (const failure of extraction.failures) {
        run.errors.push({ stage: 2, message: failure.message, recordId: failure.recordId });
        // MEM-02: retry-with-backoff bookkeeping, hung off the extraction's
        // existing failures signal — extract.ts itself is unmodified.
        const failedRecord = eligible.find((r) => r.id === failure.recordId);
        const attempts = (failedRecord?.consolidationAttempts ?? 0) + 1;
        if (attempts >= DEAD_LETTER_THRESHOLD) {
          this.store.deadLetterRecord(failure.recordId, { attempts, error: failure.message });
        } else {
          this.store.recordConsolidationRetry(failure.recordId, {
            attempts,
            error: failure.message,
            nextRetryAt: computeNextRetryAt(failure.recordId, attempts, nowMs),
          });
        }
      }
      run.counts.factsExtracted = extractedFacts.length;
    } catch (err) {
      run.errors.push({ stage: 2, message: String(err) });
    }
    this.checkpoint(run, 2);

    // ── Stage 3: REFLECT ──────────────────────────────────────────────────
    // Generate deduped insights now, grounded in the freshly-extracted facts.
    // Evidence linkage + indexing are deferred to after RESOLVE (stage 4), where
    // the persisted facts (with stable ids) exist — so insights can cite real
    // fact ids and be written into the searchable graph.
    const insights: Insight[] = [];
    try {
      const generated = await this.reflectInsights(eligible, extractedFacts, runId);
      insights.push(...generated);
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
        if (result.conflictFlagged) run.counts.conflictsFlagged += 1;
      } catch (err) {
        run.errors.push({ stage: 4, message: String(err), recordId: extracted.sourceRecordId });
      }
    }

    // Ground each insight in the persisted facts it draws on, then index it as a
    // consolidation-sourced episode so the second brain can recall its own
    // conclusions — not just the raw facts underneath them.
    for (const ins of insights) {
      try {
        ins.evidenceFactIds = matchEvidence(ins.text, newFacts);
        this.store.insertInsight(ins);
        await this.indexInsightAsEpisode(ins);
      } catch (err) {
        run.errors.push({ stage: 3, message: `index insight ${ins.id}: ${String(err)}` });
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
        this.store.rawDb
          .prepare(`UPDATE facts SET importance = ? WHERE id = ?`)
          .run(importance, fact.id);
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
    // Sync the vector index with all embeddings written this pass (covers facts
    // created via non-upsert paths, e.g. forget's compression summaries).
    // No-op when sqlite-vec is unavailable.
    try {
      this.store.reconcileVecIndex();
    } catch (err) {
      run.errors.push({ stage: 8, message: `vec reconcile: ${String(err)}` });
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
    extractedFacts: ExtractedFact[],
    runId: string,
  ): Promise<Insight[]> {
    if (records.length === 0 && extractedFacts.length === 0) return [];

    // Ground reflection in the structured facts extracted this run, with a
    // sample of raw experience text for nuance the facts may have dropped.
    const factLines = extractedFacts
      .slice(0, 30)
      .map((f, i) => `[${i}] ${f.text}`)
      .join("\n");
    const bodySample = records
      .slice(0, 8)
      .map((r) => r.text.slice(0, 200))
      .join("\n---\n");

    const prompt = `Analyze the user's recent facts and experiences and identify meaningful patterns, trends, or insights — synthesis that goes beyond any single fact.
Return a JSON array of insights: [{"text": string, "kind": "pattern"|"trend"|"preference"|"anomaly", "importance": number 1-10}]
If no clear patterns, return [].

Facts:
"""
${factLines || "(none)"}
"""

Recent experiences:
"""
${bodySample || "(none)"}
"""`;

    let parsed: Array<{ text?: string; kind?: string; importance?: number }>;
    try {
      const raw = await this.llm.complete({ prompt, json: true });
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    // Dedup against recently-generated insights so the same observation is not
    // regenerated every consolidation pass.
    const recentNorm = this.store.getRecentInsights(50).map((r) => normalizeText(r.text));
    const seen = new Set<string>();
    const out: Insight[] = [];
    for (const i of parsed) {
      if (typeof i.text !== "string" || i.text.trim().length === 0) continue;
      const norm = normalizeText(i.text);
      if (seen.has(norm)) continue;
      if (recentNorm.some((r) => isNearDuplicate(norm, r))) continue;
      seen.add(norm);
      out.push({
        id: newId(),
        runId,
        text: i.text,
        kind: (i.kind ?? "pattern") as Insight["kind"],
        evidenceFactIds: [], // linked to persisted facts after RESOLVE
        windowDays: 1,
        importance: clampImportance(i.importance),
        surfacedInBriefing: false,
        createdAt: new Date().toISOString(),
      });
    }
    return out;
  }

  /**
   * Write an insight into the searchable graph as a consolidation-sourced
   * episode, so retrieval (and the chat/agent memory it feeds) can surface the
   * brain's own conclusions — not only the raw facts underneath them.
   */
  private async indexInsightAsEpisode(ins: Insight): Promise<void> {
    const ep = await this.store.upsertEpisode({
      text: ins.text,
      occurredAt: ins.createdAt,
      provenance: { source: "consolidation", sourceId: `insight:${ins.id}`, confidence: 0.7 },
    });
    // Carry the insight's salience onto the episode for retrieval weighting.
    this.store.rawDb
      .prepare(`UPDATE episodes SET importance = ? WHERE id = ?`)
      .run(ins.importance, ep.id);
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

// ── REFLECT helpers (deterministic) ───────────────────────────────────────────

function normalizeText(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Two insight texts are near-duplicates if identical or ≥0.8 token-Jaccard. */
function isNearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  return jaccard(tokenize(a), tokenize(b)) >= 0.8;
}

/** Link an insight to the persisted facts whose text it draws on (top matches). */
function matchEvidence(insightText: string, facts: Fact[], max = 3): string[] {
  const it = tokenize(insightText);
  return facts
    .map((f) => ({ id: f.id, score: jaccard(it, tokenize(f.text)) }))
    .filter((x) => x.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.id);
}

function clampImportance(n: number | undefined): number {
  const v = Math.round(typeof n === "number" && Number.isFinite(n) ? n : 5);
  return Math.max(1, Math.min(10, v));
}
