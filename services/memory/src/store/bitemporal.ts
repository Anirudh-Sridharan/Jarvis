/**
 * Bi-temporal model helpers.
 *
 * The store records two independent time axes on every Fact:
 *  - Event time  (validFrom / validTo)   : when was this true in the world?
 *  - System time (ingestedAt / invalidatedAt) : when did Jarvis learn/unlearn it?
 *
 * Key query: "What did Jarvis believe was true ON date D?"
 *   ingestedAt <= D  AND  (invalidatedAt IS NULL OR invalidatedAt > D)
 *
 * Key query: "What WAS actually true on date D?" (time-travel)
 *   validFrom <= D  AND  (validTo IS NULL OR validTo > D)
 */

import type { Fact, ISO } from "../types.js";

/** Returns true if the fact is "live" right now (not superseded, no validTo). */
export function isLiveFact(fact: Fact): boolean {
  return fact.validTo === null && fact.invalidatedAt === null;
}

/**
 * "What Jarvis believed on date asOf?"
 * A fact is believed on asOf if:
 *   ingestedAt <= asOf  AND  (invalidatedAt IS NULL OR invalidatedAt > asOf)
 */
export function wasBelivedAt(fact: Fact, asOf: ISO): boolean {
  if (fact.ingestedAt > asOf) return false;
  if (fact.invalidatedAt !== null && fact.invalidatedAt <= asOf) return false;
  return true;
}

/**
 * "What was actually true in the world on date asOf?" (event-time query)
 * A fact was true on asOf if:
 *   validFrom <= asOf  AND  (validTo IS NULL OR validTo > asOf)
 */
export function wasTrueAt(fact: Fact, asOf: ISO): boolean {
  if (fact.validFrom > asOf) return false;
  if (fact.validTo !== null && fact.validTo <= asOf) return false;
  return true;
}

/**
 * Filter a list of facts to those that were believed (system-time) at asOf.
 */
export function factsBelivedAt(facts: Fact[], asOf: ISO): Fact[] {
  return facts.filter((f) => wasBelivedAt(f, asOf));
}

/**
 * Filter a list of facts to those that were true (event-time) at asOf.
 */
export function factsTrueAt(facts: Fact[], asOf: ISO): Fact[] {
  return facts.filter((f) => wasTrueAt(f, asOf));
}

/** Return only live (currently believed + currently valid) facts. */
export function liveFacts(facts: Fact[]): Fact[] {
  return facts.filter(isLiveFact);
}
