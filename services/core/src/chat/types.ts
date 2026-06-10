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
 * Retrieved long-term memory (feature 5). Phase 1 has no memory subsystem, so
 * this type exists only so the assembler seam is ready; nothing produces these yet.
 * TODO(phase2: feature 5) feed real RetrievedMemory[] from hybrid retrieval.
 */
export interface RetrievedMemory {
  id: string;
  tier: "episodic" | "semantic";
  text: string;
  timestamp?: string;
  score: number; // recency × importance × relevance
  sourceRef: string;
}

export interface AssembledPrompt {
  messages: { role: Role; content: string }[]; // ready for /chat/completions
  budget: {
    system: number;
    procedural: number;
    memories: number;
    history: number;
    total: number;
    replyHeadroom: number;
    contextWindow: number;
  };
  injected: RetrievedMemory[]; // for UI surfacing + debugging
  truncated: boolean;
  summarized: boolean;
}
