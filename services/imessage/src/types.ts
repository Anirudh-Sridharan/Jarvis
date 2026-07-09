/**
 * Injected interface definitions for the @jarvis/imessage package.
 *
 * These are the boundaries between the deterministic TS safety/orchestration
 * logic built in this phase and macOS chat.db / Messages.app via AppleScript
 * (Phase 10). This leaf never touches chat.db, AppleScript, or core directly —
 * it receives these interfaces at construction time. Real implementations are
 * thin adapters built in Phase 10; test doubles are fakes in
 * src/testing/fakes.ts.
 *
 * Clock is mirrored here (not imported from @jarvis/agent or any sibling leaf)
 * per the leaf-isolation invariant: @jarvis/imessage must never import
 * @jarvis/agent, @jarvis/memory, or @jarvis/core.
 */

/** Injected time source — never call Date.now()/new Date() directly in decision logic. */
export interface Clock {
  now(): number;
  isoNow(): string;
}

/** A single inbound message row, already filtered/normalized by the (Phase 10) MessageSource. */
export interface IncomingMessage {
  /** Stable per-message identity — NEVER re-derive from content. */
  guid: string;
  /** Stable per-thread identity → conversationId = "imessage:" + chatGuid. */
  chatGuid: string;
  /** Owner-allowlist check input. */
  senderId: string;
  text: string;
  /** Watermark advancement. */
  rowId: number;
  timestampMs: number;
  /**
   * chat.db is_from_me. NON-discriminating in self-chat (both sides carry
   * is_from_me=1) — the fingerprint cross-check, not this flag, is the real
   * echo guard for that conversation surface.
   */
  isFromMe: boolean;
  /** TXT-05 group-chat ignore signal (Phase 10 ChatDbReader populates from chat style). */
  isGroupChat: boolean;
}

/** Injected source of inbound messages — polled, not pushed (iMessage is poll-driven). */
export interface MessageSource {
  pollSince(watermarkRowId: number): Promise<IncomingMessage[]>;
}

/** Injected sender for outbound replies. */
export interface MessageSender {
  send(chatId: string, text: string): Promise<{ guid?: string }>;
}

/**
 * The shape core's ChatCore.send() will satisfy in Phase 10. The leaf never
 * imports core — it only knows this narrow function-type contract. This
 * narrow (string in, string out) shape is itself a structural enforcement
 * that this channel cannot trigger tool actions for as long as it's the only
 * integration seam.
 */
export interface ChatHandler {
  handle(
    message: string,
    conversationId: string,
    externalMessageId?: string,
  ): Promise<string>;
}
