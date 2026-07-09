/**
 * Conversational chat core types (feature 2). Defined locally in @jarvis/core.
 */

export type Role = "system" | "user" | "assistant";

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string; // ISO 8601
  tokenCount?: number;
  assembledPromptRef?: string; // assistant turns: debug link to the prompt used
  captureStatus?: "pending" | "ingested" | "skipped";
}

export interface Conversation {
  id: string;
  title: string; // auto-derived from first user turn
  createdAt: string;
  updatedAt: string;
  messages: Message[]; // newest last
  rollingSummary?: string; // AI summary of truncated-out history
  summaryThroughMessageId?: string;
  mode: "local" | "cloud"; // current inference backend (feature 1)
}

/**
 * Retrieved long-term memory (feature 5). Produced by @jarvis/memory hybrid
 * retrieval (ChatCore.retrieveMemories) and injected at prompt edges by the
 * assembler.
 */
export interface RetrievedMemory {
  id: string;
  tier: "episodic" | "semantic";
  text: string;
  timestamp?: string;
  score: number; // recency × importance × relevance
  sourceRef: string;
  /**
   * MEM-01: true for not-yet-consolidated/dead-lettered memories (the
   * pendingRetriever). A separate axis from `tier` (episodic-vs-semantic) —
   * provisional memories render in a distinct, separately-labeled prompt
   * block and never blend into "## Relevant memories" with vetted-fact
   * confidence. Falsy/absent for vetted memories.
   */
  provisional?: boolean;
}

export interface AssembledPrompt {
  messages: { role: Role; content: string }[]; // ready for /chat/completions
  budget: {
    system: number;
    procedural: number;
    profile: number; // feature 20 "About the user" block (0 when not injected)
    agenda: number; // connected-app calendar block (0 when not injected)
    memories: number;
    /** MEM-01: distinct "recently mentioned" provisional-memory block (0 when none). */
    pending: number;
    history: number;
    total: number;
    replyHeadroom: number;
    contextWindow: number;
  };
  injected: RetrievedMemory[]; // for UI surfacing + debugging
  truncated: boolean;
  summarized: boolean;
}
