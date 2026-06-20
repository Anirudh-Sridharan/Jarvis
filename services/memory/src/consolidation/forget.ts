/**
 * Stage 5: FORGET — FadeMem-style decay scoring and eviction.
 *
 * Decay formula: decayScore = importance_weight * recency(lastAccessed) * frequency(accessCount)
 *
 * Safety floors (NEVER evict):
 *   - importance >= 7
 *   - protected entities (minFactsPerEntity floor)
 *   - raw journal records (only derived facts are ever forgotten)
 *
 * Eviction is soft-delete (tombstone via invalidation, not physical delete).
 * The raw experience_records journal is NEVER touched.
 *
 * Compression: when ≥ COMPRESS_CLUSTER_THRESHOLD low-importance facts on the
 * same subject_id all have decayScore < COMPRESS_THRESHOLD, we use the injected
 * LlmClient to summarise them into a single compressed fact, mark the originals
 * invalidated (valid_to = now, reason = "compressed"), and insert the summary
 * fact. This keeps the journal immutable while reducing noise.
 */

import type { ForgetDecision, LlmClient } from "../types.js";
import type { MemoryStore } from "../store/memoryStore.js";
import { newId, fromJson, toJson } from "../db/database.js";

const IMPORTANCE_FLOOR = 7; // facts with importance >= this are always kept
const MIN_FACTS_PER_ENTITY = 2; // never drop below this many live facts per entity
const EVICT_THRESHOLD = 0.05; // below this decay score → evict
const COMPRESS_THRESHOLD = 0.15; // below this → compress (summarize into one)
const COMPRESS_CLUSTER_THRESHOLD = 3; // min facts on the same subject to trigger compression
const RECENCY_HALF_LIFE_DAYS = 30;

/** A compress-candidate fact, with the columns needed to build a summary. */
interface CompressFactRow {
  id: string;
  text: string;
  valid_from: string;
  subject_id: string;
  predicate: string;
  object_literal: string | null;
  source_trust: number;
  provenance: string;
}

function recencyDecay(lastAccessedAt: number, nowMs: number): number {
  const ageDays = (nowMs - lastAccessedAt) / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

function frequencyWeight(accessCount: number): number {
  // Logarithmic: more accesses = higher weight, with diminishing returns
  return Math.log1p(accessCount) / Math.log1p(10);
}

function computeDecayScore(opts: {
  importance: number;
  lastAccessedAt: number;
  accessCount: number;
  nowMs: number;
}): number {
  const importanceWeight = opts.importance / 10;
  const recency = recencyDecay(opts.lastAccessedAt, opts.nowMs);
  const frequency = frequencyWeight(opts.accessCount);
  return importanceWeight * recency * (0.5 + 0.5 * frequency);
}

/**
 * Classify a single fact into keep / evict / compress and explain why.
 * Safety floors (pin, high importance, per-entity minimum) win first and always
 * map to "keep"; otherwise the decay score decides. The human-readable `reason`
 * is surfaced in the consolidation run's audit trail.
 */
function classifyForgetAction(opts: {
  pinned: boolean;
  importance: number;
  entityFactCount: number;
  decayScore: number;
  protectedByFloor: boolean;
}): { action: ForgetDecision["action"]; reason: string } {
  const { pinned, importance, entityFactCount, decayScore, protectedByFloor } = opts;

  if (protectedByFloor) {
    if (pinned) return { action: "keep", reason: "pinned by user" };
    if (importance >= IMPORTANCE_FLOOR) {
      return { action: "keep", reason: `importance ${importance} >= floor ${IMPORTANCE_FLOOR}` };
    }
    return {
      action: "keep",
      reason: `entity below min facts floor (${entityFactCount}/${MIN_FACTS_PER_ENTITY})`,
    };
  }

  const score = decayScore.toFixed(4);
  if (decayScore < EVICT_THRESHOLD) {
    return { action: "evict", reason: `decayScore ${score} < evictThreshold ${EVICT_THRESHOLD}` };
  }
  if (decayScore < COMPRESS_THRESHOLD) {
    return { action: "compress", reason: `decayScore ${score} < compressThreshold ${COMPRESS_THRESHOLD}` };
  }
  return { action: "keep", reason: `decayScore ${score} above thresholds` };
}

/**
 * Compute forget decisions for all live facts.
 * Does NOT execute evictions — returns decisions for the consolidation pipeline
 * to apply (so the run can checkpoint between decide and execute).
 */
export function computeForgetDecisions(
  store: MemoryStore,
  nowMs: number = Date.now(),
): ForgetDecision[] {
  // Get all live facts from the DB
  const db = store.rawDb;
  const factRows = db
    .prepare(
      `SELECT id, subject_id, importance, last_accessed_at, access_count, pinned
       FROM facts
       WHERE invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > ?)`,
    )
    .all(new Date(nowMs).toISOString()) as {
    id: string;
    subject_id: string;
    importance: number;
    last_accessed_at: number;
    access_count: number;
    pinned: number;
  }[];

  // Count live facts per entity
  const factsPerEntity = new Map<string, number>();
  for (const f of factRows) {
    factsPerEntity.set(f.subject_id, (factsPerEntity.get(f.subject_id) ?? 0) + 1);
  }

  const decisions: ForgetDecision[] = [];

  for (const factRow of factRows) {
    const decayScore = computeDecayScore({
      importance: factRow.importance,
      lastAccessedAt: factRow.last_accessed_at,
      accessCount: factRow.access_count,
      nowMs,
    });

    const entityFactCount = factsPerEntity.get(factRow.subject_id) ?? 0;
    // Feature 20: a user pin is an absolute floor — never evict or compress.
    const protectedByFloor =
      factRow.pinned === 1 ||
      factRow.importance >= IMPORTANCE_FLOOR ||
      entityFactCount <= MIN_FACTS_PER_ENTITY;

    const { action, reason } = classifyForgetAction({
      pinned: factRow.pinned === 1,
      importance: factRow.importance,
      entityFactCount,
      decayScore,
      protectedByFloor,
    });

    decisions.push({
      factId: factRow.id,
      action,
      decayScore,
      lastAccessedAt: new Date(factRow.last_accessed_at).toISOString(),
      accessCount: factRow.access_count,
      importance: factRow.importance,
      protectedByFloor,
      reason,
    });
  }

  return decisions;
}

/**
 * Group compress-candidate decisions by the subject entity of their fact, so
 * compression operates per-entity (we only summarize facts that share a
 * subject). Decisions whose fact no longer exists are dropped.
 */
function groupCompressCandidatesBySubject(
  store: MemoryStore,
  toCompress: ForgetDecision[],
): Map<string, ForgetDecision[]> {
  const db = store.rawDb;
  const groupsBySubject = new Map<string, ForgetDecision[]>();
  for (const decision of toCompress) {
    const row = db
      .prepare(`SELECT subject_id FROM facts WHERE id = ?`)
      .get(decision.factId) as { subject_id: string } | null | undefined;
    if (!row) continue;
    const group = groupsBySubject.get(row.subject_id) ?? [];
    group.push(decision);
    groupsBySubject.set(row.subject_id, group);
  }
  return groupsBySubject;
}

/**
 * Insert the compression summary as a fresh live fact (predicate "summary").
 * It inherits the first source fact's provenance but is re-stamped as
 * consolidation/forget-compression output, and carries no embedding (stage 8's
 * vec reconcile picks it up). The summary intentionally has no `supersedes`
 * link — it stands in for a whole cluster, not a single prior fact.
 */
function insertSummaryFact(
  store: MemoryStore,
  subjectId: string,
  summaryText: string,
  sourceFactRows: CompressFactRow[],
  nowIso: string,
): void {
  const summaryProvenance = sourceFactRows[0]
    ? fromJson<Record<string, unknown>>(sourceFactRows[0].provenance, {})
    : {};
  summaryProvenance["capturedBy"] = "feature-6";
  summaryProvenance["source"] = "consolidation";
  summaryProvenance["sourceId"] = "forget-compression";

  store.rawDb.prepare(`
    INSERT INTO facts
      (id, subject_id, predicate, object_id, object_literal, text, embedding,
       valid_from, valid_to, ingested_at, invalidated_at, invalidated_by,
       supersedes, importance, last_accessed_at, access_count, provenance, source_trust)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(),
    subjectId,
    "summary",
    null,
    null,
    summaryText,
    null,
    sourceFactRows[0]?.valid_from ?? nowIso,
    null,
    nowIso,
    null,
    null,
    null,
    5,
    Date.now(),
    0,
    toJson(summaryProvenance),
    0.5,
  );
}

/**
 * Apply forget decisions to the store.
 * Eviction = soft invalidation (set valid_to = now, invalidated_at = now, reason = "forgotten").
 * Compression = group compress-candidate facts by subject_id; when a group reaches
 *   COMPRESS_CLUSTER_THRESHOLD, call the LlmClient to produce a summary fact, invalidate
 *   the originals, and insert the summary. Falls back to no-op eviction if no llm provided.
 * Raw journal is NEVER touched.
 */
export async function applyForgetDecisions(
  decisions: ForgetDecision[],
  store: MemoryStore,
  nowMs: number = Date.now(),
  llm?: LlmClient,
): Promise<{ evicted: number; compressed: number }> {
  const nowIso = new Date(nowMs).toISOString();
  let evicted = 0;
  let compressed = 0;

  // Separate evict candidates from compress candidates
  const toEvict = decisions.filter((d) => d.action === "evict");
  const toCompress = decisions.filter((d) => d.action === "compress");

  // Apply evictions
  for (const d of toEvict) {
    store.invalidateFact({
      factId: d.factId,
      validTo: nowIso,
      reason: `forgotten: ${d.reason}`,
    });
    evicted++;
  }

  // Compression needs an LLM to write the summary — without one, compress
  // candidates are simply left live (never evicted as a side effect).
  if (toCompress.length > 0 && llm) {
    const db = store.rawDb;
    const groupsBySubject = groupCompressCandidatesBySubject(store, toCompress);

    for (const [subjectId, group] of groupsBySubject.entries()) {
      // Only compress a cluster that's actually noisy; smaller groups stay as-is.
      if (group.length < COMPRESS_CLUSTER_THRESHOLD) continue;

      // Fetch the full fact texts for the cluster.
      const factIds = group.map((d) => d.factId);
      const placeholders = factIds.map(() => "?").join(",");
      const factRows = db
        .prepare(
          `SELECT id, text, valid_from, subject_id, predicate, object_literal, source_trust, provenance
           FROM facts WHERE id IN (${placeholders})`,
        )
        .all(...factIds) as unknown as CompressFactRow[];

      if (factRows.length === 0) continue;

      const factBullets = factRows.map((f) => `- ${f.text}`).join("\n");
      const prompt = `Summarize the following related facts about entity "${subjectId}" into a single concise summary fact.
Return only the summary text (one sentence), no JSON, no bullet points.

Facts:
${factBullets}`;

      let summaryText: string;
      try {
        summaryText = (await llm.complete({ prompt })).trim();
        if (!summaryText || summaryText === "[]") {
          // LLM returned empty / a JSON stub — fall back to a deterministic join.
          summaryText = `Summary of ${factRows.length} facts about ${subjectId}: ${factRows.map((f) => f.text).join("; ")}`;
        }
      } catch {
        // LLM failed — skip compression for this group (leave facts live).
        continue;
      }

      // Soft-delete the originals (journal entry preserved), then persist the
      // summary as a new live fact.
      for (const factRow of factRows) {
        store.invalidateFact({
          factId: factRow.id,
          validTo: nowIso,
          reason: "compressed into summary fact",
        });
      }
      insertSummaryFact(store, subjectId, summaryText, factRows, nowIso);
      compressed += factRows.length;
    }
  }

  return { evicted, compressed };
}
