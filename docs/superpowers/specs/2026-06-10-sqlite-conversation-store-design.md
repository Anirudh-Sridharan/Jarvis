# SQLite Conversation Store — Design + Plan

**Date:** 2026-06-10
**Status:** Approved (continuation of backlog run; conventional design, no fork)
**Closes:** `TODO(phase2: feature 2/4)` in `services/core/src/chat/conversationStore.ts`

## Problem

Chat history lives in `InMemoryConversationStore` — every core restart loses
all conversations. Feature 2 calls for the full transcript staying local and
durable after it leaves the context window.

## Key constraint discovered

`ChatCore` depends on LIVE conversation objects: it calls
`store.append(conv.id, "user", …)` then reads `conv.messages.slice(0, -1)`
(chatCore.ts:143-147) — the append must be visible through the previously
returned reference, and `conv.messages.length` is read again later
(line 220). A snapshot-returning store would silently produce wrong history.

## Design: write-through with live cache

`SqliteConversationStore implements ConversationStore` in
`services/core/src/chat/sqliteConversationStore.ts`:

- Constructor takes a `DatabaseSync` (tests use `:memory:`); applies schema
  idempotently (`CREATE TABLE IF NOT EXISTS`).
- Maintains a `Map<string, Conversation>` of live objects. Reads hydrate from
  SQLite on cache miss; writes go to SQLite synchronously AND mutate the live
  object — preserving the InMemory contract exactly, plus durability.
- `messages.seq` integer column preserves ordering;
  `idx_messages_conv (conversation_id, seq)`.
- `update()` persists the known columns (title, rollingSummary,
  summaryThroughMessageId, mode, updatedAt) and `Object.assign`s the live
  object (same as InMemory).
- Factory `createSqliteConversationStore(dataDir)` opens
  `<dataDir>/conversations.sqlite` (WAL); `server.ts` uses it with
  `JARVIS_DATA_DIR` (default `~/.jarvis/data`). `InMemoryConversationStore`
  stays exported for tests.

Schema:

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  rolling_summary TEXT, summary_through_message_id TEXT, mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL, token_count INTEGER,
  assembled_prompt_ref TEXT, capture_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
```

## Plan

1. `sqliteConversationStore.ts` + `test/conversationStore.test.ts`: round-trip
   create/append/update; SURVIVES a new store instance over the same DB
   (the durability point); live-object semantics (append visible through a
   previously returned reference — the ChatCore contract); title derivation;
   ordering; getOrCreate fallback. Build + suite. Commit.
2. `server.ts` swap to factory + CLAUDE.md note. Commit.

## Out of scope

- Search over transcripts (memory capture already journals turns; recall is
  the memory system's job).
- Migrating in-flight in-memory conversations (there are none — restarts lose
  them today; that's the bug being fixed).
