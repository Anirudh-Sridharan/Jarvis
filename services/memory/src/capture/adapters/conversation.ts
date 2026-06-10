/**
 * In-process conversation adapter.
 * Converts a chat turn into an ExperienceRecord via buildConversationRecord.
 */

import type { ExperienceRecord } from "../../types.js";
import { buildConversationRecord } from "../experience.js";

export interface ConversationTurnInput {
  role: "user" | "assistant" | "system";
  content: string;
  conversationId: string;
  messageId: string;
  timestamp?: string;
}

export function normalizeConversationTurn(
  input: ConversationTurnInput,
): ExperienceRecord {
  return buildConversationRecord(input);
}
