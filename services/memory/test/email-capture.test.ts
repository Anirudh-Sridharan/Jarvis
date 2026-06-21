/**
 * Tests for CaptureService.captureEmail: chunk-level dedup idempotency (emails
 * are immutable, so a re-capture inserts nothing) and that records journal as
 * gmail/email pending consolidation.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { CaptureService } from "../src/capture/capture.js";
import { FakeEmbedder } from "../src/testing/fakes.js";

function tokens(n: number): string {
  return Array.from({ length: n }, (_, i) => `tok${String(i).padStart(3, "0")}`).join(" ");
}

const MULTI = { targetChars: 60, overlapChars: 0, minChars: 10 };

function make() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-email-cap-"));
  const db = openDatabase(dir);
  const store = new MemoryStore(db, new FakeEmbedder());
  const capture = new CaptureService(store, new FakeEmbedder());
  return { store, capture };
}

const MSG = {
  messageId: "m1",
  threadId: "t1",
  from: "Alice <alice@example.com>",
  to: "me@example.com",
  subject: "Kickoff",
  date: "Mon, 01 Jun 2026 08:00:00 +0000",
};

describe("CaptureService.captureEmail", () => {
  it("captures every chunk on first sight, nothing on a re-capture (immutable)", async () => {
    const { capture } = make();
    const body = tokens(100);

    const first = await capture.captureEmail({ ...MSG, body, chunkOpts: MULTI });
    expect(first.total).toBeGreaterThan(1);
    expect(first.inserted).toBe(first.total);

    const again = await capture.captureEmail({ ...MSG, body, chunkOpts: MULTI });
    expect(again.total).toBe(first.total);
    expect(again.inserted).toBe(0); // chunk-level dedup
  });

  it("journals chunk records as gmail-sourced email, pending consolidation", async () => {
    const { store, capture } = make();
    const r = await capture.captureEmail({ ...MSG, body: tokens(100), chunkOpts: MULTI });
    const pending = store.getPendingExperienceRecords().filter((p) => p.source === "gmail");
    expect(pending).toHaveLength(r.total);
    expect(pending.every((p) => p.type === "email")).toBe(true);
  });

  it("returns a zero result for an empty body without inserting", async () => {
    const { store, capture } = make();
    const r = await capture.captureEmail({ ...MSG, body: "   \n " });
    expect(r).toEqual({ inserted: 0, total: 0 });
    expect(store.getPendingExperienceRecords().filter((p) => p.source === "gmail")).toHaveLength(0);
  });
});
