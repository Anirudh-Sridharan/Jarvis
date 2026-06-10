/**
 * Conversation store (feature 2). Phase 1: in-memory Map.
 *
 * The interface is shaped so a SQLite-backed implementation can drop in later
 * without touching ChatCore.
 * TODO(phase2: feature 2/4) replace InMemoryConversationStore with a SQLite store
 * (the full transcript stays local & searchable after it leaves the window).
 */
import { randomUUID } from "node:crypto";
import { countTokens } from "./contextBudget.js";
import type { Conversation, Message, Role } from "./types.js";

export interface ConversationStore {
  create(mode: Conversation["mode"]): Conversation;
  get(id: string): Conversation | undefined;
  getOrCreate(id: string | undefined, mode: Conversation["mode"]): Conversation;
  append(
    conversationId: string,
    role: Role,
    content: string,
    extra?: Partial<Message>,
  ): Message;
  update(conversationId: string, patch: Partial<Conversation>): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function deriveTitle(firstUserMessage: string): string {
  const t = firstUserMessage.trim().replace(/\s+/g, " ");
  return t.length <= 60 ? t : `${t.slice(0, 57)}...`;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  create(mode: Conversation["mode"]): Conversation {
    const id = randomUUID();
    const c: Conversation = {
      id,
      title: "New conversation",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      mode,
    };
    this.conversations.set(id, c);
    return c;
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  getOrCreate(id: string | undefined, mode: Conversation["mode"]): Conversation {
    if (id) {
      const existing = this.conversations.get(id);
      if (existing) return existing;
    }
    return this.create(mode);
  }

  append(
    conversationId: string,
    role: Role,
    content: string,
    extra: Partial<Message> = {},
  ): Message {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    const msg: Message = {
      id: randomUUID(),
      conversationId,
      role,
      content,
      createdAt: nowIso(),
      tokenCount: countTokens(content),
      ...extra,
    };
    conv.messages.push(msg);
    conv.updatedAt = msg.createdAt;

    // Auto-derive the title from the first user turn.
    if (role === "user" && conv.title === "New conversation") {
      conv.title = deriveTitle(content);
    }
    return msg;
  }

  update(conversationId: string, patch: Partial<Conversation>): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
    Object.assign(conv, patch, { updatedAt: nowIso() });
  }
}
