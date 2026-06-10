/**
 * External capture tests (feature 9 → 3 bridge intake):
 *   - buildExternalRecord shape + content-hash dedup key
 *   - captureExternal inserts, dedups identical passes, re-captures on change
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystem, buildExternalRecord, type MemorySystem } from "../src/index.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";

let dataDir: string;
let memory: MemorySystem;

beforeEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = mkdtempSync(join(tmpdir(), "jarvis-external-capture-"));
  memory = createMemorySystem({
    embedder: new FakeEmbedder(),
    llm: new FakeLlm(),
    dataDir,
  });
});

const eventOpts = {
  source: "gcal" as const,
  type: "calendar_event" as const,
  nativeId: "evt-1",
  text: "Calendar event: Standup — 2026-06-11T10:00Z..10:30Z",
  timestamp: "2026-06-11T10:00:00Z",
  content: { etag: '"v1"', start: "2026-06-11T10:00:00Z" },
};

describe("buildExternalRecord", () => {
  it("builds a well-formed record with content-hashed dedup key", () => {
    const r = buildExternalRecord(eventOpts);
    expect(r.source).toBe("gcal");
    expect(r.type).toBe("calendar_event");
    expect(r.actor).toBe("gcal");
    expect(r.consolidation_pending).toBe(true);
    expect(r.dedup_key).toMatch(/^gcal:evt-1:sha256:/);
    // same content → same dedup key; changed content → different
    expect(buildExternalRecord(eventOpts).dedup_key).toBe(r.dedup_key);
    expect(
      buildExternalRecord({ ...eventOpts, content: { etag: '"v2"' } }).dedup_key,
    ).not.toBe(r.dedup_key);
  });
});

describe("captureExternal", () => {
  it("inserts once and drops identical re-captures", async () => {
    const first = await memory.capture.captureExternal(eventOpts);
    const second = await memory.capture.captureExternal(eventOpts);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it("re-captures when the content changes (e.g. event moved)", async () => {
    await memory.capture.captureExternal(eventOpts);
    const moved = await memory.capture.captureExternal({
      ...eventOpts,
      text: "Calendar event: Standup — 2026-06-11T11:00Z..11:30Z",
      content: { etag: '"v2"', start: "2026-06-11T11:00:00Z" },
    });
    expect(moved.inserted).toBe(true);
  });
});
