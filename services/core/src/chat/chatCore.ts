/**
 * ChatCore (feature 2): the turn pipeline.
 *
 * send():
 *   1. receive & persist user turn (auto-derive title; emit turn start)
 *   2. (Phase 2) memory retrieval via @jarvis/memory hybrid retrieval
 *   3. load procedural block (Phase 2: from @jarvis/memory retrievalService)
 *   4. fit context budget -> verbatim history window (+ overflow to summarize)
 *   5. assemble prompt (fixed order, edge placement)
 *   6. stream generation via the InferenceGateway
 *   7. persist assistant turn; (Phase 2) fire-and-forget capture
 *
 * Yields the gateway's unified stream chunks plus a final {type:"done"} that
 * carries the conversationId + assistant messageId so the HTTP layer can emit
 * the contract's done event.
 */
import type { InferenceGateway } from "../inference/gateway.js";
import type { InferenceStreamChunk, JarvisInferenceRequest } from "../inference/types.js";
import { assemblePrompt } from "./promptAssembler.js";
import { countTokens, fitContextBudget } from "./contextBudget.js";
import { PERSONA_SYSTEM_PROMPT } from "./persona.js";
import { CALENDAR_INTENT, type AgendaSource } from "./calendarAgenda.js";
import type { ConversationStore } from "./conversationStore.js";
import type { RetrievedMemory } from "./types.js";
import type { MemorySystem, RetrievedMemory as MemRetrievedMemory } from "@jarvis/memory";

export interface ChatSendArgs {
  message: string;
  conversationId?: string;
}

export type ChatStreamEvent =
  | { type: "status"; state: string }
  | { type: "token"; text: string }
  | { type: "done"; conversationId: string; messageId: string }
  | { type: "error"; message: string };

/**
 * Adapt @jarvis/memory's RetrievedMemory to the local RetrievedMemory shape
 * used by the prompt assembler. Maps fusedScore -> score, validFrom -> timestamp.
 */
function adaptMemory(m: MemRetrievedMemory): RetrievedMemory {
  return {
    id: m.memoryId,
    tier: m.kind === "episode" ? "episodic" : "semantic",
    text: m.text,
    score: m.fusedScore,
    sourceRef: m.memoryId,
    timestamp:
      m.validFrom > 0 ? new Date(m.validFrom).toISOString() : undefined,
    // MEM-01: pendingRetriever candidates flow through kind === "pending" —
    // includePending defaults true store-side, so retrieveMemories() below
    // needs no change to receive them.
    provisional: m.kind === "pending",
  };
}

/**
 * Load the procedural block from the memory system. Returns "" on failure.
 */
function loadProceduralBlock(memory: MemorySystem | null): string {
  if (!memory) return "";
  try {
    return memory.retrieval.getProceduralBlock();
  } catch (err) {
    console.warn("[memory] getProceduralBlock failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

/**
 * Query-relevant profile facets (feature 20). Returns "" on failure — chat
 * must never hard-fail because the profile is unavailable.
 */
async function loadProfileContext(
  memory: MemorySystem | null,
  query: string,
): Promise<string> {
  if (!memory) return "";
  try {
    return await memory.profile.getProfileContext(query);
  } catch (err) {
    console.warn("[memory] getProfileContext failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

/**
 * Phase 2 memory retrieval: calls hybrid retrieval (recency × importance × relevance).
 * Returns [] on any error — chat must never hard-fail because memory is down.
 */
async function retrieveMemories(
  query: string,
  memory: MemorySystem | null,
): Promise<RetrievedMemory[]> {
  if (!memory) return [];
  try {
    const results = await memory.retrieval.retrieve(query, { k: 6 });
    return results.map(adaptMemory);
  } catch (err) {
    console.warn("[memory] retrieval failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Fire-and-forget capture of a (user, assistant) turn pair.
 * Never throws — chat reply must never be delayed by capture errors.
 */
function captureAsync(
  memory: MemorySystem | null,
  opts: {
    conversationId: string;
    userMessageId: string;
    assistantMessageId: string;
    userContent: string;
    assistantContent: string;
  },
): void {
  if (!memory) return;

  const ts = new Date().toISOString();
  Promise.allSettled([
    memory.capture.captureConversationTurn({
      role: "user",
      content: opts.userContent,
      conversationId: opts.conversationId,
      messageId: opts.userMessageId,
      timestamp: ts,
    }),
    memory.capture.captureConversationTurn({
      role: "assistant",
      content: opts.assistantContent,
      conversationId: opts.conversationId,
      messageId: opts.assistantMessageId,
      timestamp: ts,
    }),
  ]).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[memory] capture error:", r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    }
  }).catch((err: unknown) => {
    console.warn("[memory] capture unexpected error:", err instanceof Error ? err.message : String(err));
  });
}

export class ChatCore {
  constructor(
    private readonly gateway: InferenceGateway,
    private readonly store: ConversationStore,
    /** Optional memory system — if null, memory features silently degrade. */
    private readonly memory: MemorySystem | null = null,
    /** Optional connected-app agenda source (calendar mirror); null degrades. */
    private readonly agenda: AgendaSource | null = null,
  ) {}

  /**
   * Deterministic calendar context: only for calendar-shaped messages (the
   * block costs tokens), and never allowed to fail the turn.
   */
  private loadAgendaBlock(message: string, now: Date): string {
    if (!this.agenda || !CALENDAR_INTENT.test(message)) return "";
    try {
      return this.agenda.getAgendaBlock(now);
    } catch (err) {
      console.warn(
        "[chat] agenda block failed:",
        err instanceof Error ? err.message : String(err),
      );
      return "";
    }
  }

  async *send(
    args: ChatSendArgs,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const conv = this.store.getOrCreate(args.conversationId, "local");

    // 1. persist user turn
    const userMsg = this.store.append(conv.id, "user", args.message, { captureStatus: "pending" });

    // Snapshot history EXCLUDING the just-appended user message (it goes at the
    // bottom edge by the assembler).
    const priorHistory = conv.messages.slice(0, -1);

    // 2. retrieval (Phase 2: hybrid memory retrieval) + 3. procedural block
    const now = new Date();
    const memories = await retrieveMemories(args.message, this.memory);
    const procedural = loadProceduralBlock(this.memory);
    const profileContext = await loadProfileContext(this.memory, args.message);
    const agendaBlock = this.loadAgendaBlock(args.message, now);

    // Determine the active context window from the local chat default entry.
    const contextWindow = this.resolveContextWindow();

    // 4. fit the budget: how much history fits verbatim?
    // systemTokens approximates persona + date + procedural framing + agenda.
    const systemTokens =
      countTokens(PERSONA_SYSTEM_PROMPT) +
      countTokens(procedural) +
      countTokens(profileContext) +
      countTokens(agendaBlock) +
      20; // date line + headers
    const summaryTokens = conv.rollingSummary ? countTokens(conv.rollingSummary) : 0;

    const fit = fitContextBudget({
      contextWindow,
      systemTokens,
      summaryTokens,
      memories,
      history: priorHistory,
    });

    // NOTE(phase2: feature 2) fit.overflow should be folded into rollingSummary
    // via an AI summarization step (history/summarize.ts). Phase 1 drops overflow
    // from the live window (full transcript remains in the store).

    // 5. assemble
    const assembled = assemblePrompt({
      procedural,
      profileContext,
      agenda: agendaBlock,
      memories: fit.cappedMemories,
      history: fit.history,
      rollingSummary: conv.rollingSummary,
      userMessage: args.message,
      contextWindow,
      mode: conv.mode,
      now,
      truncated: fit.truncated,
      memoryAvailable: this.memory !== null,
    });

    // 6. stream generation via the gateway
    const req: Partial<JarvisInferenceRequest> = {
      messages: assembled.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      taskHint: "chat",
      maxTokens: assembled.budget.replyHeadroom,
    };

    let assistantText = "";
    let aborted = false;
    try {
      for await (const chunk of this.gateway.chat(req, signal)) {
        const out = this.relay(chunk);
        if (out) {
          if (out.type === "token") assistantText += out.text;
          // Swallow the gateway's terminal "done"; we emit our own with ids.
          if (out.type !== "done") yield out;
          if (out.type === "error") {
            // Persist whatever partial text we got, then stop.
            break;
          }
        }
      }
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    }

    if (signal?.aborted) aborted = true;

    // 7. persist assistant turn (partial replies are kept — feature 2 edge case)
    const assistantMsg = this.store.append(conv.id, "assistant", assistantText, {
      assembledPromptRef: `${conv.id}:${conv.messages.length}`,
      captureStatus: "pending",
    });

    // Phase 2: fire-and-forget capture of (user, assistant) pair.
    // Non-blocking — captures even partial/aborted replies (partial context > none).
    captureAsync(this.memory, {
      conversationId: conv.id,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      userContent: args.message,
      assistantContent: assistantText,
    });

    if (!aborted) {
      // sync mode flag with any cloud fallback that happened this turn
      this.store.update(conv.id, {
        mode: this.gateway.modelManager.isFallbackActive() ? "cloud" : "local",
      });
    }

    yield { type: "done", conversationId: conv.id, messageId: assistantMsg.id };
  }

  private relay(chunk: InferenceStreamChunk): ChatStreamEvent | undefined {
    switch (chunk.type) {
      case "status":
        return { type: "status", state: chunk.state };
      case "token":
        return { type: "token", text: chunk.text };
      case "done":
        return { type: "done", conversationId: "", messageId: "" };
      case "error":
        return { type: "error", message: chunk.message };
    }
  }

  private resolveContextWindow(): number {
    try {
      return this.gateway.registry.defaultFor("chat", "local").ctxWindow;
    } catch {
      return 16_384;
    }
  }
}
