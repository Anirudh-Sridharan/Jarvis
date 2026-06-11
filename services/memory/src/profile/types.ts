/**
 * PersonalProfile types — feature 20.
 *
 * The profile is structured data derived from semantic memory facts.
 * It is user-inspectable and editable; corrections propagate to memory invalidation.
 *
 * Deterministic vs AI boundary:
 * - Deterministic: storing/reading/editing the profile, applying corrections, versioning.
 * - AI: deriving facets from raw memory (done by feature 6 consolidation, not inline).
 */

// ── Facet types ───────────────────────────────────────────────────────────────

export interface ProfileFact<T = string> {
  /** Underlying memory fact id — used to propagate corrections/invalidations. */
  id: string;
  value: T;
  confidence: number;    // 0..1, from consolidation or user
  pinned: boolean;       // user-confirmed; never auto-overwritten
  source: "derived" | "user";
  provenance?: string;   // e.g. "3 conversations, last seen 2026-05"
  updatedAt: string;     // ISO timestamp
  /** Live fact ids holding a different value for the same subject+predicate. */
  conflictsWith?: string[];
}

export interface Person {
  name: string;
  relationship?: string;  // "spouse", "colleague", "manager"
  notes?: string;         // salient context Jarvis should remember
}

export interface Project {
  name: string;
  status: "active" | "paused" | "done";
  description?: string;
}

export interface Routine {
  description: string;  // "deep work mornings", "gym Tue/Thu"
  cadence?: string;     // "daily", "weekdays", "weekly"
}

// ── PersonalProfile ───────────────────────────────────────────────────────────

export interface PersonalProfile {
  preferences: ProfileFact[];           // tools, formats, defaults you like
  people: ProfileFact<Person>[];
  projects: ProfileFact<Project>[];
  routines: ProfileFact<Routine>[];
  communicationStyle: ProfileFact[];    // tone/verbosity descriptors
  proceduralBlock: string;              // markdown "how I like to work"
  version: number;                      // bumped on every write
  updatedAt: string;
}

// ── Service method shapes ─────────────────────────────────────────────────────

export interface CorrectFactArgs {
  factId: string;
  /** The corrected value as a freeform string (literal replacement). */
  correction: string;
}

export interface EditFacetArgs {
  facet: keyof Omit<PersonalProfile, "proceduralBlock" | "version" | "updatedAt">;
  factId: string;
  updates: Partial<ProfileFact>;
}

export interface ForgetEntityArgs {
  /** Entity name to forget — all live facts for this entity are invalidated. */
  entityName: string;
}
