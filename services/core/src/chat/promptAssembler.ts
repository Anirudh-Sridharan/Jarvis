/**
 * Prompt assembler (feature 2): fixed-order layout with lost-in-the-middle edge
 * placement, plus token-budget math and a hard overflow assert.
 *
 * Order (top -> bottom of context):
 *   1. System + persona            (top edge — strongest attention)
 *   2. Procedural "how I work"      (near top, steers the turn)
 *   3. Retrieved memories          (top-scored emitted LAST, abutting history)
 *   4. Truncated recent history    (rolling summary first, then newest verbatim)
 *   5. Current user message        (bottom edge — strongest attention)
 *
 * Phase 1 has NO memory subsystem: `memories` arrives empty and the memory block
 * is omitted entirely (no empty scaffolding). The seam below is where feature 5
 * retrieval plugs in.
 */
import { PERSONA_SYSTEM_PROMPT } from "./persona.js";
import { ContextOverflowError } from "./errors.js";
import {
  REPLY_HEADROOM,
  SAFETY_SLACK,
  countTokens,
  capProcedural,
} from "./contextBudget.js";
import type { AssembledPrompt, Message, RetrievedMemory, Role } from "./types.js";

export interface AssembleArgs {
  procedural: string; // feature 6 block (read-only); empty placeholder in Phase 1
  memories: RetrievedMemory[]; // pre-scored desc, already capped by F5 (empty in Phase 1)
  history: Message[]; // newest verbatim turns (post-truncation)
  rollingSummary?: string; // recap of truncated-out turns
  userMessage: string;
  contextWindow: number; // 16k local Qwen; larger for HF cloud
  mode: "local" | "cloud";
  now: Date;
  truncated?: boolean; // set by caller when history was trimmed
}

export function assemblePrompt(a: AssembleArgs): AssembledPrompt {
  const procedural = capProcedural(a.procedural);

  // --- TOP EDGE: system + persona (strongest attention) ---------------------
  const systemBlock = [
    PERSONA_SYSTEM_PROMPT,
    `Current time: ${a.now.toISOString()}.`,
    a.mode === "cloud" ? "Note: answering via cloud model this turn." : "",
    // Procedural "how I work" block sits near the top so it steers the turn.
    procedural ? `## How I work\n${procedural}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  // --- Retrieved memories: lost-in-the-middle aware -------------------------
  // Compact timestamped bullets; the TOP-scored memory is emitted LAST so it
  // abuts the recent history (a prompt edge); weakest memories sit in the
  // attention-dead middle.
  let memoryBlock = "";
  const injected: RetrievedMemory[] = [];
  if (a.memories.length > 0) {
    const ascending = [...a.memories].sort((x, y) => x.score - y.score); // weak->strong
    const lines = ascending.map((m) => {
      injected.push(m);
      const ts = m.timestamp ? ` (${m.timestamp.slice(0, 10)})` : "";
      return `- ${m.text}${ts}`;
    });
    memoryBlock = `## Relevant memories\n${lines.join("\n")}`;
  } // else: omit entirely — empty scaffolding wastes tokens and biases output

  // --- History: rolling summary first, then newest verbatim turns ----------
  const historyMsgs: { role: Role; content: string }[] = [];
  if (a.rollingSummary) {
    historyMsgs.push({
      role: "system",
      content: `## Earlier conversation (summary)\n${a.rollingSummary}`,
    });
  }
  for (const m of a.history) historyMsgs.push({ role: m.role, content: m.content });

  // --- BOTTOM EDGE: current user message (strongest attention) -------------
  const messages: { role: Role; content: string }[] = [
    { role: "system", content: systemBlock },
    ...(memoryBlock ? [{ role: "system" as Role, content: memoryBlock }] : []),
    ...historyMsgs,
    { role: "user", content: a.userMessage },
  ];

  // --- Budget math + hard assert -------------------------------------------
  const system = countTokens(systemBlock);
  const memTok = countTokens(memoryBlock);
  const histTok = historyMsgs.reduce((s, m) => s + countTokens(m.content), 0);
  const userTok = countTokens(a.userMessage);
  const total = system + memTok + histTok + userTok;
  const ceiling = a.contextWindow - REPLY_HEADROOM - SAFETY_SLACK;

  if (total > ceiling) {
    // Should be impossible: history was pre-trimmed by fitContextBudget().
    // Tokenizer drift is the only legitimate cause — log + signal a retry.
    throw new ContextOverflowError(total, ceiling);
  }

  return {
    messages,
    budget: {
      system,
      procedural: countTokens(procedural),
      memories: memTok,
      history: histTok,
      total,
      replyHeadroom: REPLY_HEADROOM,
      contextWindow: a.contextWindow,
    },
    injected,
    truncated: a.truncated ?? false,
    summarized: Boolean(a.rollingSummary),
  };
}
