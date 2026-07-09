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
 * With no memory system wired, `memories` arrives empty and the memory block is
 * omitted entirely (no empty scaffolding). When a memory system IS wired
 * (`memoryAvailable`) and retrieval found nothing, a short grounding note takes
 * the block's place so the model says "not stored" rather than hallucinating.
 */
import { PERSONA_SYSTEM_PROMPT } from "./persona.js";
import { ContextOverflowError } from "./errors.js";
import {
  REPLY_HEADROOM,
  SAFETY_SLACK,
  countTokens,
  capProcedural,
  capProfile,
} from "./contextBudget.js";
import type { AssembledPrompt, Message, RetrievedMemory, Role } from "./types.js";

export interface AssembleArgs {
  procedural: string; // feature 6 block (read-only); empty placeholder in Phase 1
  /** Feature 20: query-relevant "## About the user" block; "" = omit. */
  profileContext?: string;
  /** Deterministic connected-app agenda block (calendar); "" when not requested. */
  agenda?: string;
  memories: RetrievedMemory[]; // pre-scored desc, already capped by F5 (empty in Phase 1)
  history: Message[]; // newest verbatim turns (post-truncation)
  rollingSummary?: string; // recap of truncated-out turns
  userMessage: string;
  contextWindow: number; // 16k local Qwen; larger for HF cloud
  mode: "local" | "cloud";
  now: Date;
  truncated?: boolean; // set by caller when history was trimmed
  /**
   * True when a memory system is wired this turn. With it set and zero
   * memories retrieved, a short "nothing stored matched" note is emitted so
   * the model says "not stored" instead of inventing personal details.
   */
  memoryAvailable?: boolean;
}

export function assemblePrompt(a: AssembleArgs): AssembledPrompt {
  const procedural = capProcedural(a.procedural);
  const profile = capProfile(a.profileContext ?? "");

  // --- TOP EDGE: system + persona (strongest attention) ---------------------
  // Local wall-clock alongside UTC: "today"/"tomorrow" must resolve in the
  // user's day, not UTC's (an evening chat is often already "tomorrow" in UTC).
  const localNow = a.now.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const systemBlock = [
    PERSONA_SYSTEM_PROMPT,
    `Current time: ${a.now.toISOString()} (local: ${localNow}).`,
    a.mode === "cloud" ? "Note: answering via cloud model this turn." : "",
    // Procedural "how I work" block sits near the top so it steers the turn.
    procedural ? `## How I work\n${procedural}` : "",
    // Feature 20: query-relevant profile facets (block carries its own header).
    profile,
  ]
    .filter(Boolean)
    .join("\n\n");

  // --- Retrieved memories: lost-in-the-middle aware -------------------------
  // Compact timestamped bullets; the TOP-scored memory is emitted LAST so it
  // abuts the recent history (a prompt edge); weakest memories sit in the
  // attention-dead middle.
  //
  // MEM-01: vetted (!provisional) and pending (provisional) memories are
  // split BEFORE rendering — pending memories never blend into "## Relevant
  // memories" with vetted-fact confidence. They render in their own,
  // distinctly-labeled block instead (below).
  const vettedMemories = a.memories.filter((m) => !m.provisional);
  const pendingMemories = a.memories.filter((m) => m.provisional);

  let memoryBlock = "";
  const injected: RetrievedMemory[] = [];
  if (vettedMemories.length > 0) {
    const ascending = [...vettedMemories].sort((x, y) => x.score - y.score); // weak->strong
    const lines = ascending.map((m) => {
      injected.push(m);
      const ts = m.timestamp ? ` (${m.timestamp.slice(0, 10)})` : "";
      return `- ${m.text}${ts}`;
    });
    memoryBlock = `## Relevant memories\n${lines.join("\n")}`;
  } else if (a.memoryAvailable) {
    // Recall ran and found nothing. Say so explicitly — a small local model
    // otherwise fills the gap with invented personal details. (~30 tokens,
    // covered by SAFETY_SLACK in the budget math.)
    memoryBlock =
      "## Relevant memories\n" +
      "None found for this message. Do not state personal facts about the user " +
      "that are not in this conversation — say the information isn't stored and " +
      "offer to look it up.";
  } // no memory system wired: omit scaffolding; the persona grounding rules still apply

  // --- MEM-01: pending memories — distinct, separately-labeled block --------
  // Raw, unreviewed text (not yet consolidated, or extraction gave up) —
  // framed explicitly as provisional so the model never treats it with
  // vetted-fact confidence, and defers to "## Relevant memories" on conflict.
  let pendingBlock = "";
  if (pendingMemories.length > 0) {
    const ascending = [...pendingMemories].sort((x, y) => x.score - y.score); // weak->strong
    const lines = ascending.map((m) => {
      injected.push(m);
      const ts = m.timestamp ? ` (${m.timestamp.slice(0, 10)})` : "";
      return `- ${m.text}${ts}`;
    });
    pendingBlock =
      "## Recently mentioned (not yet fully processed)\n" +
      "This is raw, unreviewed text the user just said — treat it as provisional, " +
      "not a confirmed fact. If it conflicts with something in \"## Relevant memories\", " +
      "the confirmed fact wins.\n" +
      lines.join("\n");
  }

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
  // Agenda (deterministic connected-app data) precedes the memory block so the
  // top-scored memory keeps its edge position abutting history.
  const agenda = a.agenda ?? "";
  const messages: { role: Role; content: string }[] = [
    { role: "system", content: systemBlock },
    ...(agenda ? [{ role: "system" as Role, content: agenda }] : []),
    ...(memoryBlock ? [{ role: "system" as Role, content: memoryBlock }] : []),
    ...(pendingBlock ? [{ role: "system" as Role, content: pendingBlock }] : []),
    ...historyMsgs,
    { role: "user", content: a.userMessage },
  ];

  // --- Budget math + hard assert -------------------------------------------
  const system = countTokens(systemBlock);
  const agendaTok = countTokens(agenda);
  const memTok = countTokens(memoryBlock);
  const pendingTok = countTokens(pendingBlock);
  const histTok = historyMsgs.reduce((s, m) => s + countTokens(m.content), 0);
  const userTok = countTokens(a.userMessage);
  const total = system + agendaTok + memTok + pendingTok + histTok + userTok;
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
      profile: countTokens(profile),
      agenda: agendaTok,
      memories: memTok,
      pending: pendingTok,
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
