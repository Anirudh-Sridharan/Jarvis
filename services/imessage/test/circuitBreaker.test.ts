/**
 * Tests for ReplyCircuitBreaker (TXT-04: latching rolling-window reply-rate
 * guard). The failure mode this defends against is a loop of individually
 * SUCCESSFUL sends, so the breaker must never auto-close on the passage of
 * time — only an explicit reset() may close it.
 */

import { describe, it, expect } from "vitest";
import {
  ReplyCircuitBreaker,
  DEFAULT_BREAKER_WINDOW_MS,
  DEFAULT_BREAKER_MAX_REPLIES,
} from "../src/circuitBreaker.js";
import { FixedClock } from "../src/testing/fakes.js";

describe("ReplyCircuitBreaker", () => {
  it("stays closed while at or under maxReplies within the window", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock, {
      windowMs: 60_000,
      maxReplies: 5,
    });

    for (let i = 0; i < 5; i++) {
      breaker.recordReply("chat-1");
      clock.advance(1000);
    }

    expect(breaker.isOpen()).toBe(false);
  });

  it("latches open once replies to one chat exceed maxReplies within windowMs", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock, {
      windowMs: 60_000,
      maxReplies: 5,
    });

    for (let i = 0; i < 6; i++) {
      breaker.recordReply("chat-1");
      clock.advance(100);
    }

    expect(breaker.isOpen()).toBe(true);
  });

  it("stays open even after the clock advances far past the window (no auto-close)", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock, {
      windowMs: 60_000,
      maxReplies: 5,
    });

    for (let i = 0; i < 6; i++) {
      breaker.recordReply("chat-1");
    }
    expect(breaker.isOpen()).toBe(true);

    clock.advance(60_000 * 10);
    expect(breaker.isOpen()).toBe(true);
  });

  it("closes only via explicit reset(), which also clears history", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock, {
      windowMs: 60_000,
      maxReplies: 5,
    });

    for (let i = 0; i < 6; i++) {
      breaker.recordReply("chat-1");
    }
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();
    expect(breaker.isOpen()).toBe(false);

    // History cleared: 5 more replies (at/under the ceiling) should not retrip.
    for (let i = 0; i < 5; i++) {
      breaker.recordReply("chat-1");
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it("replies to one chat spread wider apart than windowMs never trip it", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock, {
      windowMs: 60_000,
      maxReplies: 5,
    });

    for (let i = 0; i < 10; i++) {
      breaker.recordReply("chat-1");
      clock.advance(70_000); // always outside the rolling window
    }

    expect(breaker.isOpen()).toBe(false);
  });

  it("replies distributed across different chats do not combine to trip the per-chat window", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock, {
      windowMs: 60_000,
      maxReplies: 5,
    });

    breaker.recordReply("chat-1");
    breaker.recordReply("chat-2");
    breaker.recordReply("chat-3");
    breaker.recordReply("chat-1");
    breaker.recordReply("chat-2");
    breaker.recordReply("chat-3");

    expect(breaker.isOpen()).toBe(false);
  });

  it("defaults windowMs/maxReplies from the exported constants when opts omitted", () => {
    const clock = new FixedClock(0);
    const breaker = new ReplyCircuitBreaker(clock);

    for (let i = 0; i < DEFAULT_BREAKER_MAX_REPLIES; i++) {
      breaker.recordReply("chat-1");
    }
    expect(breaker.isOpen()).toBe(false);

    breaker.recordReply("chat-1");
    expect(breaker.isOpen()).toBe(true);

    // Sanity: the window constant is positive and used for pruning.
    expect(DEFAULT_BREAKER_WINDOW_MS).toBeGreaterThan(0);
  });
});
