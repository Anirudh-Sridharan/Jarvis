/**
 * Quick-capture note adapter.
 * Converts a plain-text note into an ExperienceRecord.
 */

import type { ExperienceRecord } from "../../types.js";
import { buildNoteRecord } from "../experience.js";

export interface NoteInput {
  text: string;
  noteId?: string;
  tags?: string[];
  timestamp?: string;
}

export function normalizeNote(input: NoteInput): ExperienceRecord {
  return buildNoteRecord(input);
}
