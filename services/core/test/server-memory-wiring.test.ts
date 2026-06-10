/**
 * server-memory-wiring.test.ts
 *
 * Regression test for the bug where the HTTP server (server.ts) constructed
 * ChatCore WITHOUT a memory system — its `memory` arg defaulted to null, so
 * capture/retrieval silently no-op'd and nothing persisted. Symptom: "I told it
 * my name, restarted, and it didn't remember."
 *
 * This asserts the running server actually wires the memory system into
 * ChatCore: a completed chat turn must be captured into the memory store.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";
import { setMemorySystem, resetMemorySystem } from "../src/memory/memorySystem.js";

afterEach(() => {
  resetMemorySystem();
  vi.restoreAllMocks();
});

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe("server wiring: memory", () => {
  it("the server constructs ChatCore WITH the memory system (captures a turn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-server-wiring-"));
    const memory = createMemorySystem({
      embedder: new FakeEmbedder(),
      llm: new FakeLlm(),
      dataDir: dir,
    });
    // Pre-seed the singleton so server.ts's getMemorySystem(gateway) returns this.
    setMemorySystem(memory);

    // Import AFTER seeding. The VITEST guard prevents the server from listening.
    const server = await import("../src/server.js");

    // Avoid real inference — stub the gateway the server built.
    vi.spyOn(server.gateway, "chat").mockImplementation(async function* () {
      yield { type: "token" as const, text: "Nice to meet you." };
      yield { type: "done" as const };
    });

    await drain(server.chatCore.send({ message: "my name is Zara" }));
    // Capture is fire-and-forget — let it settle.
    await new Promise((r) => setTimeout(r, 50));

    const pending = memory.store.getPendingExperienceRecords();
    const texts = pending.map((r) => r.text).join("\n");
    // Fails if the server passed a null memory (capture never ran).
    expect(texts).toContain("Zara");
  });
});
