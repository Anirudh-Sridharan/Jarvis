/**
 * MessageOrchestrator — the deterministic tick() pipeline composing this
 * package's safety primitives (fingerprint echo guard, latching circuit
 * breaker, watermark/processed-GUID store) into the complete iMessage
 * channel safety logic. Poll-driven, not event-driven — Phase 10 wires a
 * real MessageSource/MessageSender/ChatHandler and calls tick() on a loop;
 * this phase only needs tick() to be directly callable from tests.
 *
 * tick() is structurally the ONLY method that can send a message or invoke
 * the injected ChatHandler — never-originate is enforced by there being
 * exactly one call site for each in this file.
 *
 * Ordered pipeline (see tick() below):
 *   (1) If the breaker is already open at tick start: return immediately.
 *       No poll, no processing, watermark untouched — messages wait for an
 *       explicit breaker.reset().
 *   (2) Poll: source.pollSince(store.getWatermark()), sort ascending by
 *       rowId, and group survivors by chatGuid (see step 3) preserving the
 *       order each chat's first surviving message appears in the batch.
 *   (3) Per message, in rowId order, evaluate skip gates in order and count
 *       each reason: (a) store.hasProcessed(guid) → alreadyProcessed;
 *       (b) isGroupChat → group; (c) senderId not in ownerHandles OR
 *       chatGuid not in allowedChatGuids (empty list fails everything) →
 *       notAllowlisted; (d) store.hasRecentFingerprint(...) → echo, AND
 *       markProcessed() the echo row immediately so it is never
 *       re-examined. Every skipped message's rowId is eligible to advance
 *       the watermark (deliberately ignored, not pending) unless a later
 *       failure in this same tick stops processing before it is reached.
 *   (4) Per surviving chat group, in order: re-check breaker.isOpen() (it
 *       may have latched mid-tick from an earlier group's send in this same
 *       tick) and STOP processing further units if open. Otherwise coalesce
 *       survivors (texts joined with "\n", conversationId = "imessage:" +
 *       chatGuid, externalMessageId = the LAST survivor's guid), call
 *       chatHandler.handle(...), then immediately markProcessed() EVERY
 *       coalesced guid — exactly-once memory capture even if the send below
 *       fails (at-most-once reply delivery, but never a duplicate handle()
 *       for the same guid). Then sender.send(chatGuid, reply). Only on send
 *       success: recordFingerprint(reply) + breaker.recordReply(chatGuid),
 *       and the group's max rowId becomes eligible to advance the
 *       watermark.
 *   (5) If handle() or send() throws: record the error and STOP the tick
 *       (no further units processed). Rows at or beyond the failed group —
 *       except GUIDs already marked processed in step (4) — are re-polled
 *       next tick; nothing already marked processed is ever re-handled.
 *   (6) Finally: advance the watermark to the max rowId that was fully
 *       handled or deliberately skipped (a no-op if nothing advanced, since
 *       the store's advanceWatermark() is itself a monotonic guard), then
 *       prune expired fingerprints. Return the TickResult.
 */

import { createHash } from "node:crypto";
import { computeFingerprint } from "./fingerprint.js";
import {
  ReplyCircuitBreaker,
  DEFAULT_BREAKER_WINDOW_MS,
  DEFAULT_BREAKER_MAX_REPLIES,
} from "./circuitBreaker.js";
import { DEFAULT_FINGERPRINT_TTL_MS } from "./fingerprint.js";
import type { ImessageStateStore } from "./store/state.js";
import type {
  Clock,
  IncomingMessage,
  MessageSource,
  MessageSender,
  ChatHandler,
} from "./types.js";

export interface OrchestratorDeps {
  source: MessageSource;
  sender: MessageSender;
  store: ImessageStateStore;
  chatHandler: ChatHandler;
  clock: Clock;
}

export interface OrchestratorConfig {
  /** Owner handle allowlist. Empty (default) = process nothing (fail closed). */
  ownerHandles?: string[];
  /** Chat GUID allowlist. Empty (default) = process nothing (fail closed). */
  allowedChatGuids?: string[];
  breakerWindowMs?: number;
  breakerMaxReplies?: number;
  fingerprintTtlMs?: number;
}

export interface TickResult {
  /** Total messages returned by this tick's poll. */
  polled: number;
  /** Number of successful chatHandler.handle() calls (one per processed chat group). */
  handled: number;
  /** Number of successful sender.send() calls. */
  sent: number;
  skipped: {
    alreadyProcessed: number;
    group: number;
    notAllowlisted: number;
    echo: number;
  };
  /** True if the breaker was open at tick start or latched mid-tick. */
  breakerOpen: boolean;
  /** The watermark value AFTER this tick's advancement (may be unchanged). */
  watermark: number;
  errors: string[];
}

/** sha256 hex of raw (unnormalized) message text — used for processed-GUID content_hash bookkeeping. */
function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type SkipReason = keyof TickResult["skipped"];

interface SkipUnit {
  kind: "skip";
  message: IncomingMessage;
  reason: SkipReason;
}

interface GroupUnit {
  kind: "group";
  chatGuid: string;
  messages: IncomingMessage[];
}

type Unit = SkipUnit | GroupUnit;

export class MessageOrchestrator {
  /** Read-only: tests and Phase 10 ops need isOpen()/reset(). */
  public readonly breaker: ReplyCircuitBreaker;
  private readonly config: Required<OrchestratorConfig>;

  constructor(
    private readonly deps: OrchestratorDeps,
    config: OrchestratorConfig = {},
  ) {
    this.config = {
      ownerHandles: config.ownerHandles ?? [],
      allowedChatGuids: config.allowedChatGuids ?? [],
      breakerWindowMs: config.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS,
      breakerMaxReplies: config.breakerMaxReplies ?? DEFAULT_BREAKER_MAX_REPLIES,
      fingerprintTtlMs: config.fingerprintTtlMs ?? DEFAULT_FINGERPRINT_TTL_MS,
    };
    this.breaker = new ReplyCircuitBreaker(deps.clock, {
      windowMs: this.config.breakerWindowMs,
      maxReplies: this.config.breakerMaxReplies,
    });
  }

  async tick(): Promise<TickResult> {
    const { store } = this.deps;

    // (1) Breaker already open at tick start: no poll, no processing.
    if (this.breaker.isOpen()) {
      return {
        polled: 0,
        handled: 0,
        sent: 0,
        skipped: { alreadyProcessed: 0, group: 0, notAllowlisted: 0, echo: 0 },
        breakerOpen: true,
        watermark: store.getWatermark(),
        errors: [],
      };
    }

    // (2) Poll + sort ascending by rowId.
    const batch = await this.deps.source.pollSince(store.getWatermark());
    const sorted = [...batch].sort((a, b) => a.rowId - b.rowId);

    // (3) Evaluate skip gates per message; build ordered units (skips +
    // per-chat survivor groups, positioned at each group's first survivor).
    const skipped: TickResult["skipped"] = {
      alreadyProcessed: 0,
      group: 0,
      notAllowlisted: 0,
      echo: 0,
    };
    const units: Unit[] = [];
    const groupByChatGuid = new Map<string, GroupUnit>();

    for (const message of sorted) {
      if (store.hasProcessed(message.guid)) {
        skipped.alreadyProcessed++;
        units.push({ kind: "skip", message, reason: "alreadyProcessed" });
        continue;
      }
      if (message.isGroupChat) {
        skipped.group++;
        units.push({ kind: "skip", message, reason: "group" });
        continue;
      }
      const allowed =
        this.config.ownerHandles.includes(message.senderId) &&
        this.config.allowedChatGuids.includes(message.chatGuid);
      if (!allowed) {
        skipped.notAllowlisted++;
        units.push({ kind: "skip", message, reason: "notAllowlisted" });
        continue;
      }
      const incomingFingerprint = computeFingerprint(message.chatGuid, message.text);
      if (store.hasRecentFingerprint(incomingFingerprint, this.config.fingerprintTtlMs)) {
        skipped.echo++;
        store.markProcessed(message.guid, message.chatGuid, contentHash(message.text));
        units.push({ kind: "skip", message, reason: "echo" });
        continue;
      }

      let group = groupByChatGuid.get(message.chatGuid);
      if (!group) {
        group = { kind: "group", chatGuid: message.chatGuid, messages: [] };
        groupByChatGuid.set(message.chatGuid, group);
        units.push(group);
      }
      group.messages.push(message);
    }

    // (4)/(5) Process units in order; stop entirely on mid-tick breaker open
    // or a handle()/send() failure.
    let maxRowId = store.getWatermark();
    let handled = 0;
    let sent = 0;
    let breakerOpenMidTick = false;
    const errors: string[] = [];

    for (const unit of units) {
      if (unit.kind === "skip") {
        maxRowId = Math.max(maxRowId, unit.message.rowId);
        continue;
      }

      // Re-check mid-tick: an earlier group's successful send in this same
      // tick may have just latched the breaker.
      if (this.breaker.isOpen()) {
        breakerOpenMidTick = true;
        break;
      }

      const { chatGuid, messages } = unit;
      const conversationId = "imessage:" + chatGuid;
      const text = messages.map((m) => m.text).join("\n");
      // Non-null: a GroupUnit is only ever created with its first survivor
      // already pushed (see the loop above), so messages is never empty.
      const lastGuid = messages[messages.length - 1]!.guid;

      let reply: string;
      try {
        reply = await this.deps.chatHandler.handle(text, conversationId, lastGuid);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        break;
      }
      handled++;

      // Exactly-once memory capture regardless of send outcome below.
      for (const message of messages) {
        store.markProcessed(message.guid, chatGuid, contentHash(message.text));
      }

      try {
        await this.deps.sender.send(chatGuid, reply);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        break;
      }
      sent++;

      store.recordFingerprint(computeFingerprint(chatGuid, reply), chatGuid);
      this.breaker.recordReply(chatGuid);

      const groupMaxRowId = Math.max(...messages.map((m) => m.rowId));
      maxRowId = Math.max(maxRowId, groupMaxRowId);
    }

    // (6) Advance watermark last, then prune expired fingerprints.
    store.advanceWatermark(maxRowId);
    store.pruneFingerprints(this.config.fingerprintTtlMs);

    return {
      polled: sorted.length,
      handled,
      sent,
      skipped,
      breakerOpen: breakerOpenMidTick,
      watermark: store.getWatermark(),
      errors,
    };
  }
}
