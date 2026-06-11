/**
 * ProfileService — feature 20.
 *
 * Derives a PersonalProfile from the semantic memory store, makes it
 * user-inspectable, and propagates user corrections back to the store
 * via fact invalidation.
 *
 * Deterministic/AI boundary:
 * - Deterministic: grouping facts by predicate/entity-type into facets, storing
 *   profile, applying corrections, versioning.
 * - AI (optional): summarise a facet's description with the injected LlmClient.
 *   Falls back to a deterministic join when no LLM is provided.
 */

import type { MemoryStore } from "../store/memoryStore.js";
import type { LlmClient, Fact } from "../types.js";
import { newId } from "../db/database.js";
import type {
  PersonalProfile,
  ProfileFact,
  Person,
  Project,
  Routine,
  CorrectFactArgs,
  EditFacetArgs,
  ForgetEntityArgs,
} from "./types.js";

// ── Predicate groupings ───────────────────────────────────────────────────────

const PREFERENCE_PREDICATES = new Set([
  "prefers",
  "likes",
  "preference",
  "dislikes",
  "avoids",
  "favors",
  "uses",
]);

const ROUTINE_PREDICATES = new Set([
  "habit_is",
  "works_best_with",
  "routine_is",
  "schedules",
  "wakes_at",
  "sleeps_at",
  "exercises",
]);

const COMMUNICATION_PREDICATES = new Set([
  "communication_style_is",
  "prefers_format",
  "verbosity_is",
  "tone_is",
  "responds_best_to",
]);

// ── LiveFact helper (avoid circular dep with bitemporal module) ───────────────

function isLive(fact: Fact): boolean {
  return fact.validTo === null && fact.invalidatedAt === null;
}

// ── Deterministic fallback description builder ────────────────────────────────

function buildFallbackDescription(facts: Fact[]): string {
  return facts.map((f) => f.objectLiteral ?? f.objectId ?? f.text).join("; ");
}

/** Anchor comparator: does candidate `f` beat `best`? Pinned first, then confidence. */
function pinnedThenConfidence(f: Fact, best: Fact): boolean {
  if (f.pinned !== best.pinned) return f.pinned;
  return f.provenance.confidence >= best.provenance.confidence;
}

// ── Row helpers ───────────────────────────────────────────────────────────────

/**
 * User-sourced facts: written by the profile UI (feature-20) or via the
 * correctFact loop (whose inserts go through upsertFact and therefore carry
 * capturedBy "feature-3" — the sourceId is the reliable marker there).
 */
function isUserSourced(fact: Fact): boolean {
  return (
    fact.provenance.capturedBy === "feature-20" ||
    fact.provenance.sourceId === "user-correction"
  );
}

function factToProfileFact(
  fact: Fact,
  description?: string,
  conflictsWith?: string[],
): ProfileFact {
  return {
    id: fact.id,
    value: description ?? fact.objectLiteral ?? fact.objectId ?? fact.text,
    confidence: fact.provenance.confidence,
    pinned: fact.pinned,
    source: isUserSourced(fact) ? "user" : "derived",
    provenance: `ingested ${fact.ingestedAt.slice(0, 10)}`,
    updatedAt: fact.ingestedAt,
    ...(conflictsWith && conflictsWith.length > 0 ? { conflictsWith } : {}),
  };
}

// ── getAllLiveFacts helper ─────────────────────────────────────────────────────
// Access the raw DB via the store's internal db property to gather all live facts.

function getAllLiveFacts(store: MemoryStore): Fact[] {
  const db = store.rawDb;
  const rows = db
    .prepare(
      `SELECT id FROM facts
       WHERE invalidated_at IS NULL
         AND (valid_to IS NULL OR valid_to > ?)`,
    )
    .all(new Date().toISOString()) as { id: string }[];
  return rows
    .map((r) => store.getFactById(r.id))
    .filter((f): f is Fact => f !== null);
}

// ── EntityType helpers ────────────────────────────────────────────────────────

function getEntityType(store: MemoryStore, entityId: string): string | null {
  const entity = store.getEntityById(entityId);
  return entity?.entityType ?? null;
}

// ── ProfileService ────────────────────────────────────────────────────────────

export class ProfileService {
  private cached: PersonalProfile | null = null;
  private version = 0;

  constructor(
    private readonly store: MemoryStore,
    private readonly llm?: LlmClient,
  ) {}

  // ── Derive ──────────────────────────────────────────────────────────────────

  /**
   * Build the structured profile from the store's semantic facts.
   * Groups facts by predicate/entity-type into facets.
   * Optionally uses the injected LlmClient to summarize freeform descriptions.
   * Falls back deterministically when no LLM is available.
   */
  async deriveProfile(): Promise<PersonalProfile> {
    const liveFacts = getAllLiveFacts(this.store);

    const preferences: ProfileFact[] = [];
    const people: ProfileFact<Person>[] = [];
    const projects: ProfileFact<Project>[] = [];
    const routines: ProfileFact<Routine>[] = [];
    const communicationStyle: ProfileFact[] = [];

    // Group people-type entities: facts whose subjectId resolves to entityType=person
    const personFactMap = new Map<string, Fact[]>(); // entityId → facts
    const projectFactMap = new Map<string, Fact[]>();

    for (const fact of liveFacts) {
      const entityType = getEntityType(this.store, fact.subjectId);

      // Entity-type-based grouping
      if (entityType === "person") {
        const existing = personFactMap.get(fact.subjectId) ?? [];
        existing.push(fact);
        personFactMap.set(fact.subjectId, existing);
        continue;
      }

      if (entityType === "project") {
        const existing = projectFactMap.get(fact.subjectId) ?? [];
        existing.push(fact);
        projectFactMap.set(fact.subjectId, existing);
        continue;
      }

      // Predicate-based grouping for self/other entities
      if (PREFERENCE_PREDICATES.has(fact.predicate)) {
        preferences.push(factToProfileFact(fact));
        continue;
      }

      if (ROUTINE_PREDICATES.has(fact.predicate)) {
        const routine: Routine = {
          description: fact.objectLiteral ?? fact.objectId ?? fact.text,
          cadence: undefined,
        };
        routines.push({
          id: fact.id,
          value: routine,
          confidence: fact.provenance.confidence,
          pinned: fact.pinned,
          source: isUserSourced(fact) ? "user" : "derived",
          provenance: `ingested ${fact.ingestedAt.slice(0, 10)}`,
          updatedAt: fact.ingestedAt,
        });
        continue;
      }

      if (COMMUNICATION_PREDICATES.has(fact.predicate)) {
        communicationStyle.push(factToProfileFact(fact));
        continue;
      }
    }

    // Build person facets
    for (const [entityId, facts] of personFactMap.entries()) {
      const entity = this.store.getEntityById(entityId);
      if (!entity) continue;

      let description: string;
      if (this.llm && facts.length > 0) {
        try {
          const raw = facts.map((f) => `${f.predicate}: ${f.objectLiteral ?? f.objectId ?? ""}`).join(", ");
          description = await this.llm.complete({
            prompt: `Summarize in one sentence what you know about ${entity.name}: ${raw}`,
          });
        } catch {
          description = buildFallbackDescription(facts);
        }
      } else {
        description = buildFallbackDescription(facts);
      }

      // Anchor: pinned facts first, then highest confidence
      const anchor = facts.reduce(
        (best, f) => (pinnedThenConfidence(f, best) ? f : best),
        facts[0]!,
      );

      const relationship = facts.find((f) => f.predicate === "relationship_is")?.objectLiteral;
      const person: Person = {
        name: entity.name,
        relationship: relationship,
        notes: description,
      };

      people.push({
        id: anchor.id,
        value: person,
        confidence: anchor.provenance.confidence,
        pinned: anchor.pinned,
        source: isUserSourced(anchor) ? "user" : "derived",
        provenance: `${facts.length} fact${facts.length !== 1 ? "s" : ""}, ingested ${anchor.ingestedAt.slice(0, 10)}`,
        updatedAt: anchor.ingestedAt,
      });
    }

    // Build project facets
    for (const [entityId, facts] of projectFactMap.entries()) {
      const entity = this.store.getEntityById(entityId);
      if (!entity) continue;

      const statusFact = facts.find((f) => f.predicate === "status_is" || f.predicate === "project_status");
      const descFact = facts.find((f) => f.predicate === "description_is" || f.predicate === "about");

      const status = (statusFact?.objectLiteral as Project["status"]) ?? "active";
      const description = descFact?.objectLiteral;

      // Anchor: pinned facts first, then highest confidence
      const anchor = facts.reduce(
        (best, f) => (pinnedThenConfidence(f, best) ? f : best),
        facts[0]!,
      );

      const project: Project = {
        name: entity.name,
        status,
        description,
      };

      projects.push({
        id: anchor.id,
        value: project,
        confidence: anchor.provenance.confidence,
        pinned: anchor.pinned,
        source: isUserSourced(anchor) ? "user" : "derived",
        provenance: `${facts.length} fact${facts.length !== 1 ? "s" : ""}, ingested ${anchor.ingestedAt.slice(0, 10)}`,
        updatedAt: anchor.ingestedAt,
      });
    }

    // Get procedural block
    const procBlock = this.store.getProceduralBlock();
    const proceduralBlock = procBlock?.markdown ?? "";

    this.version += 1;
    const profile: PersonalProfile = {
      preferences,
      people,
      projects,
      routines,
      communicationStyle,
      proceduralBlock,
      version: this.version,
      updatedAt: new Date().toISOString(),
    };

    this.cached = profile;
    return profile;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Return the cached profile (user-inspectable).
   * If no cached profile, derives it synchronously with deterministic fallback.
   */
  async getProfile(): Promise<PersonalProfile> {
    if (this.cached) return this.cached;
    return this.deriveProfile();
  }

  // ── Correction loop ─────────────────────────────────────────────────────────

  /**
   * User correction: invalidate the wrong fact (set valid_to) and insert the
   * corrected fact. Re-derives the affected facet.
   *
   * This is the "user corrects what Jarvis believes" loop:
   * 1. INSERT corrected fact with capturedBy="feature-20" (first, so a failed
   *    insert never loses the original fact)
   * 2. INVALIDATE old fact (bi-temporal: valid_to = now, invalidatedBy = new id)
   * 3. Re-derive profile so the corrected facet is reflected immediately.
   */
  async correctFact(args: CorrectFactArgs): Promise<PersonalProfile> {
    const { factId, correction } = args;
    const now = new Date().toISOString();

    // Step 1: Look up the original fact
    const original = this.store.getFactById(factId);
    if (!original) {
      throw new Error(`ProfileService.correctFact: fact ${factId} not found`);
    }

    // Step 2: Insert the corrected fact FIRST (source = feature-20,
    // user-authoritative). The insert awaits the embedder (a network call in
    // production); if it fails, the original fact must remain live.
    const newFactId = newId();
    await this.store.upsertFact({
      id: newFactId,
      subjectId: original.subjectId,
      predicate: original.predicate,
      objectId: original.objectId,
      objectLiteral: correction,
      text: `${original.predicate}: ${correction}`,
      validFrom: now,
      validTo: null,
      supersedes: factId,
      sourceTrust: 1.0,   // user correction is maximally trusted
      pinned: true,       // user input is authoritative — consolidation keeps hands off
      provenance: {
        source: "system",
        sourceId: "user-correction",
        confidence: 1.0,
      },
    });

    // Step 3: Invalidate the old fact (bi-temporal invalidation), pointing at
    // the replacement that now definitely exists.
    this.store.invalidateFact({
      factId,
      validTo: now,
      invalidatedBy: newFactId,
      reason: "user-correction",
    });

    // Step 4: Re-derive profile to reflect the correction
    return this.deriveProfile();
  }

  // ── Pin / confirm ───────────────────────────────────────────────────────────

  /**
   * Pin/unpin a fact (user confirmation). Persisted on the facts row so
   * consolidation's resolve/forget stages can respect it.
   */
  async setPinned(factId: string, pinned: boolean): Promise<PersonalProfile> {
    const updated = this.store.setFactPinned(factId, pinned);
    if (!updated) {
      throw new Error(`ProfileService.setPinned: fact ${factId} not found`);
    }
    return this.deriveProfile();
  }

  // ── Edit facet ──────────────────────────────────────────────────────────────

  /**
   * User-driven edit of a specific facet fact.
   * Updates the cached profile in-place and marks the change as "user" source.
   * For value changes, delegates to correctFact.
   */
  async editFacet(args: EditFacetArgs): Promise<PersonalProfile> {
    const { factId, updates } = args;

    if (updates.value !== undefined && typeof updates.value === "string") {
      return this.correctFact({ factId, correction: updates.value });
    }

    if (updates.pinned !== undefined) {
      return this.setPinned(factId, updates.pinned);
    }

    // For other cosmetic updates, update the cached profile in-place
    if (this.cached) {
      const facet = this.cached[args.facet] as ProfileFact[];
      const idx = facet.findIndex((f) => f.id === factId);
      if (idx !== -1 && facet[idx]) {
        (facet[idx] as ProfileFact) = { ...facet[idx], ...updates } as ProfileFact;
        this.cached = {
          ...this.cached,
          version: this.cached.version + 1,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    return this.getProfile();
  }

  // ── Forget entity ───────────────────────────────────────────────────────────

  /**
   * User-driven forget: invalidate ALL live facts for an entity.
   * The entity itself is not deleted (immutable history), just its live facts
   * are closed out (valid_to = now).
   */
  async forgetEntity(args: ForgetEntityArgs): Promise<PersonalProfile> {
    const now = new Date().toISOString();
    const liveFacts = getAllLiveFacts(this.store);

    // Find the entity by name
    let entityId: string | null = null;
    for (const fact of liveFacts) {
      const entity = this.store.getEntityById(fact.subjectId);
      if (
        entity &&
        entity.name.toLowerCase() === args.entityName.toLowerCase()
      ) {
        entityId = entity.id;
        break;
      }
    }

    if (!entityId) {
      // Nothing to forget — re-derive and return
      return this.deriveProfile();
    }

    // Invalidate all live facts for this entity
    const entityFacts = liveFacts.filter((f) => f.subjectId === entityId);
    for (const fact of entityFacts) {
      this.store.invalidateFact({
        factId: fact.id,
        validTo: now,
        reason: "user-forget",
      });
    }

    // Re-derive profile
    return this.deriveProfile();
  }

  // ── Procedural block passthrough ────────────────────────────────────────────

  /**
   * Get the current "how I like to work" procedural block.
   */
  getProceduralBlock(): string {
    return this.store.getProceduralBlock()?.markdown ?? "";
  }
}
