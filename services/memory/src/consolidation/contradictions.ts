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

    if (prior.pinned) {
      // Feature 20: a user-confirmed fact is never superseded by consolidation.
      // Record the incoming fact as historical (closed interval) and flag the
      // conflict so the run reports it and the UI can surface it.
      const closedFact = await store.upsertFact({
        ...buildFactInput(incoming, entityId),
        validTo: incoming.validFrom,
      });
      return { invalidatedIds: [], conflictFlagged: true, factId: closedFact.id };
    }

    const winner = pickWinner(priorAsExtracted, incoming);

    if (winner === "tie" && sameDay(priorAsExtracted.validFrom, incoming.validFrom)) {
      const decision = await aiTieBreak(priorAsExtracted, incoming, llm);
      if (decision === "ambiguous") {
        // Keep both — insert incoming without invalidating prior
        const fact = await store.upsertFact(buildFactInput(incoming, entityId));
        factId = fact.id;
        conflictFlagged = true;
      } else if (decision === "incoming") {
        // Incoming wins — invalidate prior
        const fact = await store.upsertFact({
          ...buildFactInput(incoming, entityId),
          supersedes: prior.id,
        });
        factId = fact.id;
        store.invalidateFact({ factId: prior.id, validTo: incoming.validFrom, invalidatedBy: fact.id });
        invalidatedIds.push(prior.id);
      } else {
        // Prior wins — insert incoming as historical (closed at its own
        // validFrom: a zero-length interval, never a negative one)
        const closedFact = await store.upsertFact({
          ...buildFactInput(incoming, entityId),
          validTo: incoming.validFrom,
        });
        factId = closedFact.id;
      }
    } else if (winner === "incoming") {
      const fact = await store.upsertFact({
        ...buildFactInput(incoming, entityId),
        supersedes: prior.id,
      });
      factId = fact.id;
      store.invalidateFact({ factId: prior.id, validTo: incoming.validFrom, invalidatedBy: fact.id });
      invalidatedIds.push(prior.id);
    } else {
      // Prior wins — insert incoming as historical, closed at its own
      // validFrom (zero-length interval, never a negative one)
      const closedFact = await store.upsertFact({
        ...buildFactInput(incoming, entityId),
        validTo: incoming.validFrom,
      });
      factId = closedFact.id;
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
