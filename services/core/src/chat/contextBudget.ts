/**
 * Context-budget + history truncation (feature 2). Deterministic, pure, testable.
 *
 * Fill segments in priority order — system+persona (fixed) -> procedural (capped)
 * -> memories -> history. Trim by cheapest loss: memories by LOWEST score first,
 * history by OLDEST turn first. The assembler asserts the final total fits.
 *
 * Token counting reuses the cheap chars/4 estimator (see inference/tokens.ts).
 * TODO(phase2: feature 1) back countTokens with the active model's real tokenizer.
 */
import { estimateTokens } from "../inference/tokens.js";
import type { Message, RetrievedMemory } from "./types.js";

export const REPLY_HEADROOM = 2_000;
export const SAFETY_SLACK = 100;
export const PROCEDURAL_CAP = 800;
export const MEMORY_CAP = 2_500;

export function countTokens(s: string): number {
  return estimateTokens(s);
}

export interface FitResult {
  history: Message[]; // newest verbatim turns that fit
  overflow: Message[]; // older turns to fold into the rolling summary
  cappedMemories: RetrievedMemory[];
  truncated: boolean;
}

export interface FitArgs {
  contextWindow: number;
  systemTokens: number; // persona + date + procedural (already capped)
  summaryTokens: number; // existing rolling summary, if any
  memories: RetrievedMemory[];
  history: Message[]; // newest last
}

/**
 * Deterministic fitting. Returns the verbatim window that fits, the overflow to
 * summarize, and the memory set capped to its segment budget.
 */
export function fitContextBudget(args: FitArgs): FitResult {
  const { contextWindow, systemTokens, summaryTokens } = args;

  // 1. Establish the input ceiling.
  const ceiling = contextWindow - REPLY_HEADROOM - SAFETY_SLACK;

  // 2. Cap memories to their segment budget, dropping lowest score first.
  let memUsed = 0;
  const cappedMemories: RetrievedMemory[] = [];
  for (const m of [...args.memories].sort((a, b) => b.score - a.score)) {
    const t = countTokens(m.text);
    if (memUsed + t > MEMORY_CAP) continue; // skip; keep scanning lower items
    memUsed += t;
    cappedMemories.push(m);
  }

  // 3. Remaining room for history (verbatim turns).
  const fixed = systemTokens + summaryTokens + memUsed;
  const historyBudget = ceiling - fixed;

  // 4. Walk history newest -> oldest, keeping turns that fit.
  const kept: Message[] = [];
  const overflow: Message[] = [];
  let used = 0;
  for (let i = args.history.length - 1; i >= 0; i--) {
    const msg = args.history[i];
    if (!msg) continue;
    const t = msg.tokenCount ?? countTokens(msg.content);
    if (used + t <= historyBudget) {
      kept.unshift(msg);
      used += t;
    } else {
      // Everything from here back is older -> overflow into the summary.
      overflow.unshift(...args.history.slice(0, i + 1));
      break;
    }
  }

  return {
    history: kept,
    overflow, // caller folds these into rollingSummary (feature 2 summarize step)
    cappedMemories,
    truncated: overflow.length > 0,
  };
}

/** Cap the procedural block to its hard budget (PROCEDURAL_CAP tokens). */
export function capProcedural(procedural: string): string {
  if (!procedural) return "";
  if (countTokens(procedural) <= PROCEDURAL_CAP) return procedural;
  // chars/4 estimate => cap by characters. Real tokenizer would cap by tokens.
  const maxChars = PROCEDURAL_CAP * 4;
  return procedural.slice(0, maxChars);
}
