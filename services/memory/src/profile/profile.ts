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
import { buildProfileContext, type ProfileContextOptions } from "./inject.js";

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

// ── Deterministic fallback description builder ────────────────────────────────

function buildFallbackDescription(facts: Fact[]): string {
  return facts.map((f) => f.objectLiteral ?? f.objectId ?? f.text).join("; ");
}

/** Anchor comparator: does candidate `f` beat `best`? Pinned first, then confidence. */
function pinnedThenConfidence(f: Fact, best: Fact): boolean {
  if (f.pinned !== best.pinned) return f.pinned;
  return f.provenance.confidence >= best.provenance.confidence;
}

/**
 * Pick the representative fact for a multi-fact facet (person/project): the
 * pinned-then-highest-confidence fact carries the facet's id and metadata.
 * Caller guarantees a non-empty group.
 */
function selectAnchor(facts: Fact[]): Fact {
  return facts.reduce((best, f) => (pinnedThenConfidence(f, best) ? f : best), facts[0]!);
}

/** Provenance line for an aggregated facet, e.g. "3 facts, ingested 2026-05-01". */
function factCountProvenance(facts: Fact[], anchor: Fact): string {
  const plural = facts.length !== 1 ? "s" : "";
  return `${facts.length} fact${plural}, ingested ${anchor.ingestedAt.slice(0, 10)}`;
}

// ── Conflict detection ────────────────────────────────────────────────────────

/**
 * Deterministic contradiction surfacing (feature 20): >1 live fact on the same
 * (subject, predicate) holding differing values ⇒ cross-flag them all so the
 * UI can show the conflict and injection can pick a winner.
 * "summary" facts (forget-stage compression output) are exempt — multiple
 * summaries of the same entity are normal, not contradictory.
 */
function detectConflicts(liveFacts: Fact[]): Map<string, string[]> {
  const conflictsById = new Map<string, string[]>();
  const groups = new Map<string, Fact[]>();
  for (const f of liveFacts) {
    if (f.predicate === "summary") continue;
    const key = `${f.subjectId}\u0000${f.predicate}`;
    const g = groups.get(key) ?? [];
    g.push(f);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const values = new Set(
      g.map((f) => (f.objectLiteral ?? f.objectId ?? f.text).toLowerCase().trim()),
    );
    if (values.size < 2) continue;
    for (const f of g) {
      conflictsById.set(f.id, g.filter((o) => o.id !== f.id).map((o) => o.id));
    }
  }
  return conflictsById;
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

/**
 * Build the shared ProfileFact envelope (id/confidence/pinned/source/provenance/
 * updatedAt + optional conflict cross-flag) around a typed value, anchored on a
 * representative fact. Used for the facet kinds whose value is a structured
 * object (Person/Project/Routine) rather than a literal string. `conflictsWith`
 * is only emitted when non-empty so the field stays absent for clean facets.
 */
function buildFacet<T>(
  anchor: Fact,
  value: T,
  provenance: string,
  conflictsWith: string[] | undefined,
): ProfileFact<T> {
  return {
    id: anchor.id,
    value,
    confidence: anchor.provenance.confidence,
    pinned: anchor.pinned,
    source: isUserSourced(anchor) ? "user" : "derived",
    provenance,
    updatedAt: anchor.ingestedAt,
    ...(conflictsWith && conflictsWith.length > 0 ? { conflictsWith } : {}),
  };
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
   * Falls back deterministically when no LLM is available — or when the caller
   * passes { useLlm: false } (the inline chat path, where AI is banned).
   */
  async deriveProfile(
    opts: { useLlm?: boolean; cache?: boolean } = {},
  ): Promise<PersonalProfile> {
    const useLlm = opts.useLlm !== false;
    const cache = opts.cache !== false;
    // Lean reads: this runs per chat turn — no embedding parsing, two queries.
    const liveFacts = this.store.listLiveFacts();
    const entityHeaders = this.store.listEntityHeaders();
    const conflictsById = detectConflicts(liveFacts);

    const preferences: ProfileFact[] = [];
    const people: ProfileFact<Person>[] = [];
    const projects: ProfileFact<Project>[] = [];
    const routines: ProfileFact<Routine>[] = [];
    const communicationStyle: ProfileFact[] = [];

    // Group people-type entities: facts whose subjectId resolves to entityType=person
    const personFactMap = new Map<string, Fact[]>(); // entityId → facts
    const projectFactMap = new Map<string, Fact[]>();

    for (const fact of liveFacts) {
      const entityType = entityHeaders.get(fact.subjectId)?.entityType ?? null;

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
        preferences.push(factToProfileFact(fact, undefined, conflictsById.get(fact.id)));
        continue;
      }

      if (ROUTINE_PREDICATES.has(fact.predicate)) {
        const routine: Routine = {
          description: fact.objectLiteral ?? fact.objectId ?? fact.text,
          cadence: undefined,
        };
        // A routine is a single fact, so it anchors on itself and uses the
        // plain "ingested <date>" provenance (not the multi-fact count form).
        routines.push(
          buildFacet(
            fact,
            routine,
            `ingested ${fact.ingestedAt.slice(0, 10)}`,
            conflictsById.get(fact.id),
          ),
        );
        continue;
      }

      if (COMMUNICATION_PREDICATES.has(fact.predicate)) {
        communicationStyle.push(factToProfileFact(fact, undefined, conflictsById.get(fact.id)));
        continue;
      }
    }

    // Build person facets
    for (const [entityId, facts] of personFactMap.entries()) {
      const entity = entityHeaders.get(entityId);
      if (!entity) continue;

      let description: string;
      if (useLlm && this.llm && facts.length > 0) {
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

      const anchor = selectAnchor(facts);
      const relationship = facts.find((f) => f.predicate === "relationship_is")?.objectLiteral;
      const person: Person = {
        name: entity.name,
        relationship: relationship,
        notes: description,
      };

      people.push(
        buildFacet(
          anchor,
          person,
          factCountProvenance(facts, anchor),
          conflictsById.get(anchor.id),
        ),
      );
    }

    // Build project facets
    for (const [entityId, facts] of projectFactMap.entries()) {
      const entity = entityHeaders.get(entityId);
      if (!entity) continue;

      const statusFact = facts.find((f) => f.predicate === "status_is" || f.predicate === "project_status");
      const descFact = facts.find((f) => f.predicate === "description_is" || f.predicate === "about");

      const status = (statusFact?.objectLiteral as Project["status"]) ?? "active";
      const description = descFact?.objectLiteral;
      const anchor = selectAnchor(facts);

      const project: Project = {
        name: entity.name,
        status,
        description,
      };

      projects.push(
        buildFacet(
          anchor,
          project,
          factCountProvenance(facts, anchor),
          conflictsById.get(anchor.id),
        ),
      );
    }

    // Get procedural block
    const procBlock = this.store.getProceduralBlock();
    const proceduralBlock = procBlock?.markdown ?? "";

    // The per-turn chat derivation passes cache:false — it must not clobber
    // the user-inspectable cached profile or inflate the version counter.
    if (cache) this.version += 1;
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

    if (cache) this.cached = profile;
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
   *
   * Person/project cards aggregate many facts under one anchor id — a
   * "Confirm" on the card must protect the whole group, not just the anchor
   * (the card's displayed relationship/notes come from the other facts too).
   */
  async setPinned(factId: string, pinned: boolean): Promise<PersonalProfile> {
    const updated = this.store.setFactPinned(factId, pinned);
    if (!updated) {
      throw new Error(
        `ProfileService.setPinned: fact ${factId} not found or no longer live`,
      );
    }
    const entityType = this.store.listEntityHeaders().get(updated.subjectId)?.entityType;
    if (entityType === "person" || entityType === "project") {
      for (const f of this.store.listLiveFacts()) {
        if (f.subjectId === updated.subjectId && f.id !== updated.id) {
          this.store.setFactPinned(f.id, pinned);
        }
      }
    }
    return this.deriveProfile();
  }

  /**
   * User-driven forget of a single fact (spec: every fact can be deleted).
   * Bi-temporal: the fact is closed out (valid_to = now), never hard-deleted.
   */
  async forgetFact(factId: string): Promise<PersonalProfile> {
    const fact = this.store.getFactById(factId);
    if (!fact) {
      throw new Error(`ProfileService.forgetFact: fact ${factId} not found`);
    }
    this.store.invalidateFact({
      factId,
      validTo: new Date().toISOString(),
      reason: "user-forget",
    });
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

    if (updates.value !== undefined) {
      // Object values (Person/Project/Routine) aggregate several facts; a
      // silent cache-only update would be lost on the next derivation.
      throw new Error(
        "ProfileService.editFacet: object-value edits are not supported — correct the underlying facts individually",
      );
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
    const liveFacts = this.store.listLiveFacts();
    const entityHeaders = this.store.listEntityHeaders();

    // Find the entity by name
    let entityId: string | null = null;
    for (const fact of liveFacts) {
      const entity = entityHeaders.get(fact.subjectId);
      if (
        entity &&
        entity.name.toLowerCase() === args.entityName.toLowerCase()
      ) {
        entityId = fact.subjectId;
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

  // ── Prompt injection (feature 2/5 consumers) ───────────────────────────────

  /**
   * Query-relevant profile block for prompt injection. Deterministic
   * end-to-end: derivation skips LLM person summaries (fallback join is used)
   * because this runs inline on the chat path.
   */
  async getProfileContext(query: string, opts?: ProfileContextOptions): Promise<string> {
    const profile = await this.deriveProfile({ useLlm: false, cache: false });
    return buildProfileContext(profile, query, opts);
  }
}
