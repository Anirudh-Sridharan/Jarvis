/**
 * Test fakes for @jarvis/imessage — scriptable doubles for all injected
 * interfaces (Clock, MessageSource, MessageSender, ChatHandler).
 *
 * FixedClock         — deterministic Clock; advance()/set() move time forward
 * FakeMessageSource   — scripted backlog; pollSince(w) returns rowId > w, ascending
 * FakeMessageSender   — records every send; scriptable error + onSend hook
 * FakeChatHandler     — records every handle() call tuple; scriptable reply/error
 */

import type {
  Clock,
  IncomingMessage,
  MessageSource,
  MessageSender,
  ChatHandler,
} from "../types.js";

// ---------------------------------------------------------------------------
// FixedClock
// ---------------------------------------------------------------------------

export class FixedClock implements Clock {
  private ms: number;

  constructor(epochMs: number = Date.now()) {
    this.ms = epochMs;
  }

  now(): number {
    return this.ms;
  }

  isoNow(): string {
    return new Date(this.ms).toISOString();
  }

  /** Advance clock by delta ms. */
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }

  /** Set clock to a specific time. */
  set(epochMs: number): void {
    this.ms = epochMs;
  }
}

// ---------------------------------------------------------------------------
// FakeMessageSource
// ---------------------------------------------------------------------------

export class FakeMessageSource implements MessageSource {
  private backlog: IncomingMessage[] = [];

  /** Test helper: add a message to the backlog available for future polls. */
  enqueue(msg: IncomingMessage): void {
    this.backlog.push(msg);
  }

  /** Returns only messages with rowId > watermarkRowId, ascending by rowId. */
  async pollSince(watermarkRowId: number): Promise<IncomingMessage[]> {
    return this.backlog
      .filter((m) => m.rowId > watermarkRowId)
      .sort((a, b) => a.rowId - b.rowId);
  }
}

// ---------------------------------------------------------------------------
// FakeMessageSender
// ---------------------------------------------------------------------------

export class FakeMessageSender implements MessageSender {
  public sends: Array<{ chatId: string; text: string }> = [];
  /** Fired after every successful (recorded) send. */
  public onSend?: (chatId: string, text: string) => void;
  /** 1-based call index on which send() throws BEFORE recording. */
  public errorOnNthSend?: number;

  private callCount = 0;

  async send(chatId: string, text: string): Promise<{ guid?: string }> {
    this.callCount++;
    if (this.errorOnNthSend !== undefined && this.callCount === this.errorOnNthSend) {
      throw new Error(`FakeMessageSender: scripted error on send #${this.callCount}`);
    }
    this.sends.push({ chatId, text });
    this.onSend?.(chatId, text);
    return { guid: `sent-${this.sends.length}` };
  }
}

// ---------------------------------------------------------------------------
// FakeChatHandler
// ---------------------------------------------------------------------------

export interface FakeChatHandlerCall {
  message: string;
  conversationId: string;
  externalMessageId?: string;
}

export class FakeChatHandler implements ChatHandler {
  public calls: FakeChatHandlerCall[] = [];
  /** Scripted reply text returned by handle() (default "ok"). Ignored if replyFn is set. */
  public reply = "ok";
  /** Optional override: compute the reply dynamically from the call. */
  public replyFn?: (call: FakeChatHandlerCall) => string;
  /** 1-based call index on which handle() throws BEFORE recording. */
  public errorOnNthCall?: number;

  private callCount = 0;

  async handle(
    message: string,
    conversationId: string,
    externalMessageId?: string,
  ): Promise<string> {
    this.callCount++;
    if (this.errorOnNthCall !== undefined && this.callCount === this.errorOnNthCall) {
      throw new Error(`FakeChatHandler: scripted error on call #${this.callCount}`);
    }
    const call: FakeChatHandlerCall = { message, conversationId, externalMessageId };
    this.calls.push(call);
    return this.replyFn ? this.replyFn(call) : this.reply;
  }
}
