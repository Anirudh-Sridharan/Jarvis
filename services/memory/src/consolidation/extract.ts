/**
 * Stage 2: EXTRACT — extract discrete facts from pending experience records.
 *
 * The actual fact extraction is AI-driven (injected LlmClient).
 * The orchestration, validation gate, and schema parsing are deterministic TS.
 */

import type { ExtractedFact, LlmClient, ExperienceRecord } from "../types.js";
import { newId } from "../db/database.js";

const MIN_CONFIDENCE = 0.5;

const EXTRACTION_PROMPT = `You extract discrete, updateable FACTS from a personal note or conversation turn.
Return a JSON array. Each fact: {"entity": string, "predicate": string, "object": string, "text": string, "confidence": number}.
RULES:
- One atomic fact per item. Do NOT summarize into blobs.
- entity = canonical subject (a person, project, preference, or "self" for the user).
- predicate = short normalized relation (e.g. "feels", "works_on", "prefers", "deadline_is", "manager_is").
- confidence = 0..1 how certain the fact is literally stated or strongly implied.
- Extract only what is supported by the text. If nothing factual, return [].
NOTE:
"""{{body}}"""`;

interface RawExtractedFact {
  entity: string;
  predicate: string;
  object: string;
  text: string;
  confidence: number;
}

function safeParseFactArray(raw: string): RawExtractedFact[] {
  try {
    // Extract JSON array from potentially wrapped response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is RawExtractedFact =>
        typeof f === "object" &&
        f !== null &&
        typeof f.entity === "string" &&
        typeof f.predicate === "string" &&
        typeof f.object === "string" &&
        typeof f.text === "string" &&
        typeof f.confidence === "number",
    );
  } catch {
    return [];
  }
}

function isSaneFact(f: RawExtractedFact): boolean {
  return (
    f.entity.length > 0 &&
    f.predicate.length > 0 &&
    f.predicate.length < 100 &&
    f.object.length > 0 &&
    f.confidence >= 0 &&
    f.confidence <= 1
  );
}

function sourceTrustForKind(source: string): number {
  switch (source) {
    case "note": return 0.9;
    case "conversation": return 0.8;
    case "gmail": return 0.7;
    case "gcal": return 0.8;
    case "github": return 0.75;
    default: return 0.5;
  }
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  /** Ids of records whose extraction completed (even if zero facts came out). */
  processedRecordIds: string[];
  /** Records whose LLM call failed — they must stay consolidation_pending. */
  failures: { recordId: string; message: string }[];
}

export async function extractFacts(
  records: ExperienceRecord[],
  llm: LlmClient,
  runId: string,
): Promise<ExtractionResult> {
  const out: ExtractedFact[] = [];
  const processedRecordIds: string[] = [];
  const failures: { recordId: string; message: string }[] = [];

  for (const rec of records) {
    // Assistant chat turns are the model's own output: any personal fact in
    // them either restates what the user/memory already provided (redundant)
    // or was hallucinated (graph poison — invented "facts" about the user
    // would later be retrieved as grounded memories). Mark processed so the
    // record doesn't stay pending, but never mint facts from it.
    if (rec.source === "conversation" && rec.actor === "assistant") {
      processedRecordIds.push(rec.id);
      continue;
    }
    try {
      const prompt = EXTRACTION_PROMPT.replace("{{body}}", rec.text.slice(0, 4096));
      const raw = await llm.complete({ prompt, json: true });
      const parsed = safeParseFactArray(raw);

      for (const f of parsed) {
        if (f.confidence < MIN_CONFIDENCE) continue;
        if (!isSaneFact(f)) continue;
        out.push({
          id: newId(),
          runId,
          sourceRecordId: rec.id,
          entity: f.entity.trim(),
          predicate: f.predicate.trim().toLowerCase().replace(/\s+/g, "_"),
          object: f.object.trim(),
          text: f.text.trim(),
          confidence: f.confidence,
          validFrom: rec.timestamp,
          validTo: null,
          sourceTrust: sourceTrustForKind(rec.source),
        });
      }
      processedRecordIds.push(rec.id);
    } catch (err) {
      // Per-record isolation: skip bad records — they stay pending and are
      // reported so the run can be marked "partial".
      failures.push({ recordId: rec.id, message: String(err) });
    }
  }

  return { facts: out, processedRecordIds, failures };
}
