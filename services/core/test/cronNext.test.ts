/**
 * cronNext.test.ts
 *
 * Unit coverage for parseCronNext — the next-occurrence inversion of
 * @jarvis/integrations' isDue() (see services/core/src/agent/cronNext.ts).
 * Structure mirrors services/integrations/test/scheduler.test.ts's
 * describe("isDue", ...) block (one describe per pattern), with assertions
 * inverted from "is it due" to "what's the next occurrence".
 */

import { describe, it, expect } from "vitest";
import { parseCronNext } from "../src/agent/cronNext.js";

describe("parseCronNext", () => {
  describe("interval schedule '*/N * * * *'", () => {
    it("returns the next N-minute boundary strictly after `after`", () => {
      const t = new Date("2026-06-09T10:07:00Z").getTime();
      const next = parseCronNext("*/30 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T10:30:00Z").getTime());
    });

    it("on an exact boundary, returns the NEXT boundary (strict >)", () => {
      const boundary = new Date("2026-06-09T10:30:00Z").getTime();
      const next = parseCronNext("*/30 * * * *", "UTC", boundary);
      expect(next).toBe(boundary + 30 * 60_000);
    });

    it("one ms before a boundary, returns that boundary", () => {
      const boundary = new Date("2026-06-09T10:30:00Z").getTime();
      const next = parseCronNext("*/30 * * * *", "UTC", boundary - 1);
      expect(next).toBe(boundary);
    });

    it("supports a small interval (every 5 minutes)", () => {
      const t = new Date("2026-06-09T10:02:00Z").getTime();
      const next = parseCronNext("*/5 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T10:05:00Z").getTime());
    });

    it("rolls across an hour boundary", () => {
      const t = new Date("2026-06-09T10:45:00Z").getTime();
      const next = parseCronNext("*/30 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T11:00:00Z").getTime());
    });

    it("returns null for */0 (non-positive interval)", () => {
      expect(parseCronNext("*/0 * * * *", "UTC", Date.now())).toBeNull();
    });

    it("returns null for a non-numeric interval", () => {
      expect(parseCronNext("*/abc * * * *", "UTC", Date.now())).toBeNull();
    });
  });

  describe("hourly schedule 'M * * * *'", () => {
    it("returns this hour's :M when `after` is strictly before it", () => {
      const t = new Date("2026-06-09T10:05:00Z").getTime();
      const next = parseCronNext("15 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T10:15:00Z").getTime());
    });

    it("returns next hour's :M when `after` is at/after this hour's :M", () => {
      const t = new Date("2026-06-09T10:15:00Z").getTime(); // exactly on :15
      const next = parseCronNext("15 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T11:15:00Z").getTime());
    });

    it("returns next hour's :M when `after` is past this hour's :M", () => {
      const t = new Date("2026-06-09T10:45:00Z").getTime();
      const next = parseCronNext("15 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T11:15:00Z").getTime());
    });

    it("top-of-hour boundary: at exactly HH:00:00, returns next hour's :00 (strict)", () => {
      const t = new Date("2026-06-09T10:00:00Z").getTime();
      const next = parseCronNext("0 * * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T11:00:00Z").getTime());
    });
  });

  describe("daily schedule 'M H * * *'", () => {
    it("returns today's H:M when `after` is strictly before it", () => {
      const t = new Date("2026-06-09T01:00:00Z").getTime();
      const next = parseCronNext("0 3 * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-09T03:00:00Z").getTime());
    });

    it("returns tomorrow's H:M when `after` is at/after today's H:M", () => {
      const t = new Date("2026-06-09T03:00:00Z").getTime(); // exactly on target
      const next = parseCronNext("0 3 * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-10T03:00:00Z").getTime());
    });

    it("returns tomorrow's H:M when `after` is past today's H:M", () => {
      const t = new Date("2026-06-09T12:00:00Z").getTime();
      const next = parseCronNext("0 3 * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-10T03:00:00Z").getTime());
    });

    it("midnight rollover: today's 00:00 already passed -> returns tomorrow's 00:00 UTC", () => {
      const t = new Date("2026-06-09T23:00:00Z").getTime();
      const next = parseCronNext("0 0 * * *", "UTC", t);
      expect(next).toBe(new Date("2026-06-10T00:00:00Z").getTime());
    });

    it("handles month rollover correctly", () => {
      const t = new Date("2026-06-30T12:00:00Z").getTime();
      const next = parseCronNext("0 3 * * *", "UTC", t);
      expect(next).toBe(new Date("2026-07-01T03:00:00Z").getTime());
    });
  });

  describe("malformed expressions", () => {
    it("returns null when not exactly 5 whitespace-separated fields (too few)", () => {
      expect(parseCronNext("0 3 * *", "UTC", Date.now())).toBeNull();
    });

    it("returns null when not exactly 5 whitespace-separated fields (too many)", () => {
      expect(parseCronNext("0 3 * * * *", "UTC", Date.now())).toBeNull();
    });

    it("returns null for an empty expression", () => {
      expect(parseCronNext("", "UTC", Date.now())).toBeNull();
    });

    it("returns null for a non-numeric minute field", () => {
      expect(parseCronNext("abc 3 * * *", "UTC", Date.now())).toBeNull();
    });

    it("returns null for a non-numeric hour field", () => {
      expect(parseCronNext("0 xyz * * *", "UTC", Date.now())).toBeNull();
    });
  });

  describe("`after` default parameter", () => {
    it("defaults to Date.now() when `after` is omitted", () => {
      const before = Date.now();
      const next = parseCronNext("*/30 * * * *", "UTC");
      const after = Date.now();
      expect(next).not.toBeNull();
      // next must be strictly after some `after` value sampled around "now".
      expect(next as number).toBeGreaterThan(before);
      expect(next as number).toBeLessThanOrEqual(after + 30 * 60_000);
    });
  });
});
