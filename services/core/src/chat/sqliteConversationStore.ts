/**
 * SQLite-backed ConversationStore (feature 2/4): the full transcript stays
 * local and durable across core restarts.
 *
 * Write-through with a live cache: reads hydrate Conversation objects from
 * SQLite on cache miss; writes persist synchronously AND mutate the cached
 * object. ChatCore depends on LIVE references — it appends and then expects
 * the new message to be visible through a previously returned conversation
 * (chatCore.ts run loop) — so this store must never hand out snapshots.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countTokens } from "./contextBudget.js";
import type { Conversation, Message, Role } from "./types.js";
import type { ConversationStore } from "./conversationStore.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rolling_summary TEXT,
  summary_through_message_id TEXT,
  mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  token_count INTEGER,
  assembled_prompt_ref TEXT,
  capture_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
`;

function nowIso(): string {
  return new Date().toISOString();
}

function deriveTitle(firstUserMessage: string): string {
  const t = firstUserMessage.trim().replace(/\s+/g, " ");
  return t.length <= 60 ? t : `${t.slice(0, 57)}...`;
}

export class SqliteConversationStore implements ConversationStore {
  /** Live objects — ChatCore holds references across appends. */
  private readonly cache = new Map<string, Conversation>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  create(mode: Conversation["mode"]): Conversation {
    const c: Conversation = {
      id: randomUUID(),
      title: "New conversation",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      mode,
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, mode)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.title, c.createdAt, c.updatedAt, c.mode);
    this.cache.set(c.id, c);
    return c;
  }

  get(id: string): Conversation | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const messages = (
      this.db
        .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC`)
        .all(id) as Record<string, unknown>[]
    ).map(rowToMessage);

    const conv: Conversation = {
      id: row["id"] as string,
      title: row["title"] as string,
      createdAt: row["created_at"] as string,
      updatedAt: row["updated_at"] as string,
      messages,
      rollingSummary: (row["rolling_summary"] as string | null) ?? undefined,
      summaryThroughMessageId:
        (row["summary_through_message_id"] as string | null) ?? undefined,
      mode: row["mode"] as Conversation["mode"],
    };
    this.cache.set(id, conv);
    return conv;
  }

  getOrCreate(id: string | undefined, mode: Conversation["mode"]): Conversation {
    if (id) {
      const existing = this.get(id);
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
    const conv = this.get(conversationId);
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

    this.db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, seq, role, content, created_at,
            token_count, assembled_prompt_ref, capture_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        conversationId,
        conv.messages.length,
        msg.role,
        msg.content,
        msg.createdAt,
        msg.tokenCount ?? null,
        msg.assembledPromptRef ?? null,
        msg.captureStatus ?? null,
      );

    conv.messages.push(msg);
    conv.updatedAt = msg.createdAt;

    let title = conv.title;
    if (role === "user" && conv.title === "New conversation") {
      title = deriveTitle(content);
      conv.title = title;
    }
    this.db
      .prepare(`UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?`)
      .run(conv.updatedAt, title, conversationId);

    return msg;
  }

  update(conversationId: string, patch: Partial<Conversation>): void {
    const conv = this.get(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    Object.assign(conv, patch, { updatedAt: nowIso() });
    this.db
      .prepare(
        `UPDATE conversations SET
           title = ?, updated_at = ?, rolling_summary = ?,
           summary_through_message_id = ?, mode = ?
         WHERE id = ?`,
      )
      .run(
        conv.title,
        conv.updatedAt,
        conv.rollingSummary ?? null,
        conv.summaryThroughMessageId ?? null,
        conv.mode,
        conversationId,
      );
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row["id"] as string,
    conversationId: row["conversation_id"] as string,
    role: row["role"] as Role,
    content: row["content"] as string,
    createdAt: row["created_at"] as string,
    tokenCount: (row["token_count"] as number | null) ?? undefined,
    assembledPromptRef: (row["assembled_prompt_ref"] as string | null) ?? undefined,
    captureStatus:
      ((row["capture_status"] as string | null) ?? undefined) as Message["captureStatus"],
  };
}

/** Open (or create) the durable store at `<dataDir>/conversations.sqlite`. */
export function createSqliteConversationStore(dataDir: string): SqliteConversationStore {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "conversations.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  return new SqliteConversationStore(db);
}
