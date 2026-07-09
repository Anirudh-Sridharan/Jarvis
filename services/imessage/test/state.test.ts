/**
 * Tests for ImessageStateStore — the leaf's own imessage.db (TXT-07
 * watermark persistence, TXT-04 fingerprint TTL, TXT-06 GUID-keyed
 * exactly-once tracking).
 *
 * Covers:
 *   - Watermark: fresh-db default, monotonic advance, restart persistence
 *   - Fingerprints: record/hasRecentFingerprint TTL, prune removes expired rows
 *   - Processed GUIDs: mark/has, GUID-keyed (not content-keyed), restart persistence
 *   - DDL idempotency (constructing twice on one dataDir does not throw)
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImessageStateStore } from "../src/store/state.js";
import { FixedClock } from "../src/testing/fakes.js";

describe("ImessageStateStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("watermark", () => {
    it("returns 0 on a fresh database", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store = new ImessageStateStore(tmpDir, new FixedClock(0));
      expect(store.getWatermark()).toBe(0);
    });

    it("advances and persists the watermark", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store = new ImessageStateStore(tmpDir, new FixedClock(0));
      store.advanceWatermark(7);
      expect(store.getWatermark()).toBe(7);
    });

    it("is monotonic: a lower rowId never moves it backwards", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store = new ImessageStateStore(tmpDir, new FixedClock(0));
      store.advanceWatermark(7);
      store.advanceWatermark(3);
      expect(store.getWatermark()).toBe(7);
    });

    it("persists across process restart: a second store on the same dataDir reads it", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store1 = new ImessageStateStore(tmpDir, new FixedClock(0));
      store1.advanceWatermark(7);

      const store2 = new ImessageStateStore(tmpDir, new FixedClock(0));
      expect(store2.getWatermark()).toBe(7);
    });
  });

  describe("fingerprints", () => {
    it("hasRecentFingerprint matches within the TTL window", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const clock = new FixedClock(0);
      const store = new ImessageStateStore(tmpDir, clock);

      store.recordFingerprint("fp-1", "chat-1");
      expect(store.hasRecentFingerprint("fp-1", 10_000)).toBe(true);
    });

    it("stops matching after the clock advances past the TTL", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const clock = new FixedClock(0);
      const store = new ImessageStateStore(tmpDir, clock);

      store.recordFingerprint("fp-1", "chat-1");
      clock.advance(10_001);
      expect(store.hasRecentFingerprint("fp-1", 10_000)).toBe(false);
    });

    it("flips false purely from query-time recency, without any prune call", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const clock = new FixedClock(0);
      const store = new ImessageStateStore(tmpDir, clock);

      store.recordFingerprint("fp-1", "chat-1");
      expect(store.hasRecentFingerprint("fp-1", 5_000)).toBe(true);
      clock.advance(5_001);
      // No pruneFingerprints() call here — recency must be query-time.
      expect(store.hasRecentFingerprint("fp-1", 5_000)).toBe(false);
    });

    it("pruneFingerprints physically removes expired rows", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const clock = new FixedClock(0);
      const store = new ImessageStateStore(tmpDir, clock);

      store.recordFingerprint("fp-old", "chat-1");
      clock.advance(10_001);
      store.recordFingerprint("fp-new", "chat-1");

      store.pruneFingerprints(10_000);

      // fp-old is now unrecoverable even with a huge TTL (row physically gone).
      expect(store.hasRecentFingerprint("fp-old", 10_000_000)).toBe(false);
      // fp-new (recorded after the advance, at "now") is still within any TTL.
      expect(store.hasRecentFingerprint("fp-new", 10_000_000)).toBe(true);
    });
  });

  describe("processed GUIDs", () => {
    it("markProcessed then hasProcessed is true", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store = new ImessageStateStore(tmpDir, new FixedClock(0));

      store.markProcessed("guid-1", "chat-1", "hash-a");
      expect(store.hasProcessed("guid-1")).toBe(true);
    });

    it("hasProcessed is false for an unknown guid", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store = new ImessageStateStore(tmpDir, new FixedClock(0));
      expect(store.hasProcessed("unknown-guid")).toBe(false);
    });

    it("persists across a second store instance on the same dataDir", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store1 = new ImessageStateStore(tmpDir, new FixedClock(0));
      store1.markProcessed("guid-1", "chat-1", "hash-a");

      const store2 = new ImessageStateStore(tmpDir, new FixedClock(0));
      expect(store2.hasProcessed("guid-1")).toBe(true);
    });

    it("is GUID-keyed, not content-keyed: same guid, different contentHash does not throw and stays processed", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      const store = new ImessageStateStore(tmpDir, new FixedClock(0));

      store.markProcessed("guid-1", "chat-1", "hash-a");
      expect(() =>
        store.markProcessed("guid-1", "chat-1", "hash-b-edited"),
      ).not.toThrow();
      expect(store.hasProcessed("guid-1")).toBe(true);
    });
  });

  describe("DDL idempotency", () => {
    it("constructing a store twice on one dataDir does not throw", () => {
      tmpDir = mkdtempSync(join(tmpdir(), "imsg-state-"));
      expect(() => {
        const a = new ImessageStateStore(tmpDir, new FixedClock(0));
        a.advanceWatermark(1);
        const b = new ImessageStateStore(tmpDir, new FixedClock(0));
        expect(b.getWatermark()).toBe(1);
      }).not.toThrow();
    });
  });
});
