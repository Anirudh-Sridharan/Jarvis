/**
 * Stage 4: RESOLVE — contradiction detection and temporal validity resolution.
 *
 * Resolution precedence (deterministic):
 *  1. Higher sourceTrust wins on conflict.
 *  2. On equal trust, newer validFrom wins.
 *  3. On same-day equal-trust conflict → AI tie-break (or keep both with conflict flag).
 *
 * Facts are never deleted — superseded facts have validTo set.
 */

import type { ExtractedFact, LlmClient } from "../types.js";
import type { MemoryStore } from "../store/memoryStore.js";
import type { FactInput } from "../store/memoryStore.js";
import { newId } from "../db/database.js";

const SAME_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function sameDay(a: string, b: string): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < SAME_DAY_WINDOW_MS;
}

function sameValue(a: ExtractedFact, b: ExtractedFact): boolean {
  return a.object.toLowerCase().trim() === b.object.toLowerCase().trim();
}

function pickWinner(
  prior: ExtractedFact,
  incoming: ExtractedFact,
): "prior" | "incoming" | "tie" {
  if (prior.sourceTrust > incoming.sourceTrust) return "prior";
  if (incoming.sourceTrust > prior.sourceTrust) return "incoming";
  // Equal trust: newer validFrom wins
  if (incoming.validFrom > prior.validFrom) return "incoming";
  if (prior.validFrom > incoming.validFrom) return "prior";
  return "tie";
}

async function aiTieBreak(
  prior: ExtractedFact,
  incoming: ExtractedFact,
  llm: LlmClient,
): Promise<"prior" | "incoming" | "ambiguous"> {
  try {
    const prompt = `Two conflicting facts about the same entity+predicate. Which is more likely correct?
Prior: "${prior.text}" (confidence: ${prior.confidence})
Incoming: "${incoming.text}" (confidence: ${incoming.confidence})
Reply with JSON: {"winner": "prior" | "incoming" | "ambiguous", "reason": string}`;
    const raw = await llm.complete({ prompt, json: true });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return "ambiguous";
    const parsed = JSON.parse(match[0]) as { winner?: string };
    if (parsed.winner === "prior") return "prior";
    if (parsed.winner === "incoming") return "incoming";
    return "ambiguous";
  } catch {
    return "ambiguous";
  }
}

export interface ResolveResult {
  invalidatedIds: string[];
  conflictFlagged: boolean;
  factId: string;
}

/**
 * Incoming fact wins: insert it as the live fact (supersedes the prior) and
 * close the prior's validity at the incoming's validFrom. Returns the new fact
 * id and the invalidated prior id so the caller can record it.
 */
async function supersedePrior(
  incoming: ExtractedFact,
  prior: { id: string },
  entityId: string,
  store: MemoryStore,
): Promise<{ factId: string; invalidatedId: string }> {
  const fact = await store.upsertFact({
    ...buildFactInput(incoming, entityId),
    supersedes: prior.id,
  });
  store.invalidateFact({ factId: prior.id, validTo: incoming.validFrom, invalidatedBy: fact.id });
  return { factId: fact.id, invalidatedId: prior.id };
}

/**
 * Prior fact wins: still record the incoming fact for history, but insert it
 * already closed at its own validFrom (a zero-length interval — never negative).
 * The prior stays live untouched.
 */
async function insertAsHistorical(
  incoming: ExtractedFact,
  entityId: string,
  store: MemoryStore,
): Promise<string> {
  const closedFact = await store.upsertFact({
    ...buildFactInput(incoming, entityId),
    validTo: incoming.validFrom,
  });
  return closedFact.id;
}

/**
 * Resolve a single incoming ExtractedFact against existing live facts in the store.
 * Returns the new fact's id and a list of invalidated prior fact ids.
 */
export async function resolveFact(
  incoming: ExtractedFact,
  store: MemoryStore,
  llm: LlmClient,
): Promise<ResolveResult> {
  // Find existing entity by name
  const entityId = incoming.entity; // In this phase, entity = subject key
  // Get live facts with matching entity+predicate
  const history = store.getFactHistory(entityId, incoming.predicate);
  const livePriors = history.filter(
    (f) => f.validTo === null && f.invalidatedAt === null,
  );

  const invalidatedIds: string[] = [];
  let conflictFlagged = false;
  let factId: string;

  if (livePriors.length === 0) {
    // No conflict — insert fresh
    const fact = await store.upsertFact(buildFactInput(incoming, entityId));
    factId = fact.id;
  } else if (livePriors.some((p) => p.pinned)) {
    // Feature 20: a user-confirmed fact is never superseded by consolidation —
    // checked across ALL live priors, not just the oldest. Spec: "keep both
    // with timestamps and surface the conflict rather than silently picking",
    // so unless the incoming value duplicates a live prior, it is inserted
    // LIVE: deriveProfile cross-flags the pair for the UI, while injection's
    // conflict-winner rule (pinned first) keeps the pinned fact in prompts.
    const duplicateOf = livePriors.find(
      (p) =>
        (p.objectLiteral ?? p.objectId ?? "").toLowerCase().trim() ===
        incoming.object.toLowerCase().trim(),
    );
    if (duplicateOf) {
      return { invalidatedIds: [], conflictFlagged: false, factId: duplicateOf.id };
    }
    const liveFact = await store.upsertFact(buildFactInput(incoming, entityId));
    return { invalidatedIds: [], conflictFlagged: true, factId: liveFact.id };
  } else {
    const prior = livePriors[0]!;
    const priorAsExtracted: ExtractedFact = {
      id: prior.id,
      runId: incoming.runId,
      sourceRecordId: prior.provenance.sourceId,
      entity: entityId,
      predicate: incoming.predicate,
      object: prior.objectLiteral ?? prior.objectId ?? "",
      text: prior.text,
      confidence: prior.provenance.confidence,
      validFrom: prior.validFrom,
      validTo: prior.validTo,
      sourceTrust: prior.sourceTrust,
    };

    if (sameValue(priorAsExtracted, incoming)) {
      // Exact duplicate — no new fact needed; return existing
      return { invalidatedIds: [], conflictFlagged: false, factId: prior.id };
    }

    const winner = pickWinner(priorAsExtracted, incoming);

    // Same-day equal-trust conflict → ask the AI to break the tie; an ambiguous
    // verdict keeps both facts live and raises the conflict flag.
    if (winner === "tie" && sameDay(priorAsExtracted.validFrom, incoming.validFrom)) {
      const decision = await aiTieBreak(priorAsExtracted, incoming, llm);
      if (decision === "ambiguous") {
        const fact = await store.upsertFact(buildFactInput(incoming, entityId));
        factId = fact.id;
        conflictFlagged = true;
      } else if (decision === "incoming") {
        const superseded = await supersedePrior(incoming, prior, entityId, store);
        factId = superseded.factId;
        invalidatedIds.push(superseded.invalidatedId);
      } else {
        factId = await insertAsHistorical(incoming, entityId, store);
      }
    } else if (winner === "incoming") {
      const superseded = await supersedePrior(incoming, prior, entityId, store);
      factId = superseded.factId;
      invalidatedIds.push(superseded.invalidatedId);
    } else {
      // Prior wins (higher trust, or newer/equal validFrom outside the tie path).
      factId = await insertAsHistorical(incoming, entityId, store);
    }
  }

  return { invalidatedIds, conflictFlagged, factId };
}

function buildFactInput(f: ExtractedFact, subjectId: string): FactInput {
  return {
    id: f.id ?? newId(),
    subjectId,
    predicate: f.predicate,
    objectLiteral: f.object,
    text: f.text,
    validFrom: f.validFrom,
    validTo: f.validTo ?? null,
    sourceTrust: f.sourceTrust,
    supersedes: f.supersedesFactId ?? null,
    provenance: {
      source: "consolidation",
      sourceId: f.sourceRecordId,
      confidence: f.confidence,
    },
  };
}
