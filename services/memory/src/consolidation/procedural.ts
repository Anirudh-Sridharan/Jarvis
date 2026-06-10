/**
 * Stage 7: UPDATE PROCEDURAL BLOCK
 *
 * The procedural block is a singleton markdown document: "how I like to work".
 * It is injected into the chat system prompt by the core (feature 2).
 *
 * Update rule:
 *  1. Gather new procedural-signal facts (predicate in {prefers, dislikes, habit_is, works_best_with}).
 *  2. Ask the LLM to produce a revised markdown block incorporating them.
 *  3. Write via store.writeProceduralBlock (deterministic apply).
 */

import type { LlmClient, Fact } from "../types.js";
import type { MemoryStore } from "../store/memoryStore.js";

const PROCEDURAL_PREDICATES = new Set([
  "prefers",
  "dislikes",
  "habit_is",
  "works_best_with",
  "likes",
  "avoids",
  "preference",
]);

const UPDATE_PROMPT = `You are updating a personal "how I like to work" document for a personal AI assistant.
Current document:
"""
{{current}}
"""

New signals to incorporate (facts learned today):
{{signals}}

Instructions:
- Produce a concise, well-structured markdown document (max ~500 words).
- Integrate new signals. If a new signal contradicts an existing preference, update the preference.
- Keep it practical and first-person.
- Return ONLY the markdown, no commentary.`;

/**
 * Extract procedural facts from all live semantic facts.
 */
export function extractProceduralFacts(store: MemoryStore): Fact[] {
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const rows = db
    .prepare(
      `SELECT * FROM facts WHERE invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > ?)`,
    )
    .all(new Date().toISOString()) as { predicate: string; id: string }[];

  const proceduralIds = rows
    .filter((r) => PROCEDURAL_PREDICATES.has(r.predicate))
    .map((r) => r.id);

  return proceduralIds
    .map((id) => store.getFactById(id))
    .filter((f): f is Fact => f !== null);
}

/**
 * Update the procedural block using the injected LLM.
 * If there are no new procedural signals, returns without writing.
 */
export async function updateProceduralBlock(
  store: MemoryStore,
  llm: LlmClient,
  newFacts: Fact[],
): Promise<boolean> {
  const proceduralFacts = newFacts.filter((f) =>
    PROCEDURAL_PREDICATES.has(f.predicate),
  );

  if (proceduralFacts.length === 0) return false;

  const current = store.getProceduralBlock();
  const currentMarkdown = current?.markdown ?? "";

  const signals = proceduralFacts
    .map((f) => `- ${f.subjectId} ${f.predicate} ${f.objectLiteral ?? f.objectId ?? ""}`)
    .join("\n");

  const prompt = UPDATE_PROMPT.replace("{{current}}", currentMarkdown || "(empty)").replace(
    "{{signals}}",
    signals,
  );

  try {
    const newMarkdown = await llm.complete({ prompt });
    const sourceFactIds = proceduralFacts.map((f) => f.id);
    store.writeProceduralBlock(newMarkdown.trim(), sourceFactIds, "feature-6");
    return true;
  } catch {
    return false;
  }
}
