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

  for (const f of factRows) {
    const decayScore = computeDecayScore({
      importance: f.importance,
      lastAccessedAt: f.last_accessed_at,
      accessCount: f.access_count,
      nowMs,
    });

    const entityFactCount = factsPerEntity.get(f.subject_id) ?? 0;
    // Feature 20: a user pin is an absolute floor — never evict or compress.
    const protectedByFloor =
      f.pinned === 1 ||
      f.importance >= IMPORTANCE_FLOOR ||
      entityFactCount <= MIN_FACTS_PER_ENTITY;

    let action: "keep" | "evict" | "compress";
    let reason: string;

    if (protectedByFloor) {
      action = "keep";
      reason = f.pinned === 1
        ? "pinned by user"
        : f.importance >= IMPORTANCE_FLOOR
          ? `importance ${f.importance} >= floor ${IMPORTANCE_FLOOR}`
          : `entity below min facts floor (${entityFactCount}/${MIN_FACTS_PER_ENTITY})`;
    } else if (decayScore < EVICT_THRESHOLD) {
      action = "evict";
      reason = `decayScore ${decayScore.toFixed(4)} < evictThreshold ${EVICT_THRESHOLD}`;
    } else if (decayScore < COMPRESS_THRESHOLD) {
      action = "compress";
      reason = `decayScore ${decayScore.toFixed(4)} < compressThreshold ${COMPRESS_THRESHOLD}`;
    } else {
      action = "keep";
      reason = `decayScore ${decayScore.toFixed(4)} above thresholds`;
    }

    decisions.push({
      factId: f.id,
      action,
      decayScore,
      lastAccessedAt: new Date(f.last_accessed_at).toISOString(),
      accessCount: f.access_count,
      importance: f.importance,
      protectedByFloor,
      reason,
    });
  }

  return decisions;
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

  // Compression: group by subject entity
  if (toCompress.length > 0 && llm) {
    const db = store.rawDb;

    // Group compress candidates by subject_id
    const groupsBySubject = new Map<string, ForgetDecision[]>();
    for (const d of toCompress) {
      // Look up the subject_id for this factId
      const row = db
        .prepare(`SELECT subject_id FROM facts WHERE id = ?`)
        .get(d.factId) as { subject_id: string } | null | undefined;
      if (!row) continue;
      const subjectId = row.subject_id;
      const group = groupsBySubject.get(subjectId) ?? [];
      group.push(d);
      groupsBySubject.set(subjectId, group);
    }

    // For each group that meets the threshold, compress
    for (const [subjectId, group] of groupsBySubject.entries()) {
      if (group.length < COMPRESS_CLUSTER_THRESHOLD) {
        // Not enough facts to compress — leave them as-is (no eviction)
        continue;
      }

      // Fetch the full fact texts
      const factIds = group.map((d) => d.factId);
      const placeholders = factIds.map(() => "?").join(",");
      const factRows = db
        .prepare(
          `SELECT id, text, valid_from, subject_id, predicate, object_literal, source_trust, provenance
           FROM facts WHERE id IN (${placeholders})`,
        )
        .all(...factIds) as {
        id: string;
        text: string;
        valid_from: string;
        subject_id: string;
        predicate: string;
        object_literal: string | null;
        source_trust: number;
        provenance: string;
      }[];

      if (factRows.length === 0) continue;

      // Build summary prompt
      const factBullets = factRows.map((f) => `- ${f.text}`).join("\n");
      const prompt = `Summarize the following related facts about entity "${subjectId}" into a single concise summary fact.
Return only the summary text (one sentence), no JSON, no bullet points.

Facts:
${factBullets}`;

      let summaryText: string;
      try {
        summaryText = (await llm.complete({ prompt })).trim();
        if (!summaryText || summaryText === "[]") {
          // Fallback if LLM returns empty / JSON stub
          summaryText = `Summary of ${factRows.length} facts about ${subjectId}: ${factRows.map((f) => f.text).join("; ")}`;
        }
      } catch {
        // Skip compression for this group if LLM fails
        continue;
      }

      // Invalidate originals (soft-delete, journal entry preserved)
      for (const factRow of factRows) {
        store.invalidateFact({
          factId: factRow.id,
          validTo: nowIso,
          reason: "compressed into summary fact",
        });
      }

      // Insert summary fact
      const summaryId = newId();
      const summaryProvenance = factRows[0]
        ? fromJson<Record<string, unknown>>(factRows[0].provenance, {})
        : {};
      summaryProvenance["capturedBy"] = "feature-6";
      summaryProvenance["source"] = "consolidation";
      summaryProvenance["sourceId"] = "forget-compression";

      db.prepare(`
        INSERT INTO facts
          (id, subject_id, predicate, object_id, object_literal, text, embedding,
           valid_from, valid_to, ingested_at, invalidated_at, invalidated_by,
           supersedes, importance, last_accessed_at, access_count, provenance, source_trust)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        summaryId,
        subjectId,
        "summary",
        null,
        null,
        summaryText,
        null,
        factRows[0]?.valid_from ?? nowIso,
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

      compressed += factRows.length;
    }
  }

  return { evicted, compressed };
}
