/**
 * Tests for the fingerprint module (TXT-04 secondary loop-prevention net).
 *
 * Covers:
 *   - normalizeMessageText: casing/punctuation/whitespace normalization
 *   - computeFingerprint: determinism, chatId sensitivity, text-variant equality
 */

import { describe, it, expect } from "vitest";
import {
  normalizeMessageText,
  computeFingerprint,
  DEFAULT_FINGERPRINT_TTL_MS,
} from "../src/fingerprint.js";

describe("normalizeMessageText", () => {
  it("lowercases, strips punctuation, collapses whitespace, and trims", () => {
    expect(normalizeMessageText("Buy MILK!!")).toBe("buy milk");
    expect(normalizeMessageText("  Buy   milk  ")).toBe("buy milk");
  });

  it("normalizes casing/punctuation/whitespace variants identically", () => {
    expect(normalizeMessageText("Buy MILK!!")).toBe(
      normalizeMessageText("buy milk"),
    );
    expect(normalizeMessageText("Hello, World!")).toBe(
      normalizeMessageText("hello world"),
    );
    expect(normalizeMessageText("what's   up?")).toBe(
      normalizeMessageText("whats up"),
    );
  });

  it("returns empty string for punctuation-only input", () => {
    expect(normalizeMessageText("!!!???...")).toBe("");
    expect(normalizeMessageText("   ")).toBe("");
  });
});

describe("computeFingerprint", () => {
  it("is deterministic: two calls with the same inputs produce identical hashes", () => {
    const a = computeFingerprint("chat-1", "Buy milk");
    const b = computeFingerprint("chat-1", "Buy milk");
    expect(a).toBe(b);
  });

  it("differs across chatIds for identical text", () => {
    const a = computeFingerprint("chat-1", "Buy milk");
    const b = computeFingerprint("chat-2", "Buy milk");
    expect(a).not.toBe(b);
  });

  it("is identical across casing/punctuation variants of the same text in the same chat", () => {
    const a = computeFingerprint("chat-1", "Buy MILK!!");
    const b = computeFingerprint("chat-1", "buy milk");
    expect(a).toBe(b);
  });

  it("differs for genuinely different text in the same chat", () => {
    const a = computeFingerprint("chat-1", "Buy milk");
    const b = computeFingerprint("chat-1", "Buy eggs");
    expect(a).not.toBe(b);
  });

  it("produces a sha256 hex digest (64 lowercase hex chars)", () => {
    const fp = computeFingerprint("chat-1", "Buy milk");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DEFAULT_FINGERPRINT_TTL_MS", () => {
  it("is a positive number of milliseconds (10 minutes)", () => {
    expect(DEFAULT_FINGERPRINT_TTL_MS).toBe(10 * 60_000);
  });
});
