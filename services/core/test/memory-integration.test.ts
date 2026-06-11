/**
 * memory-integration.test.ts
 *
 * Verifies that @jarvis/memory is correctly wired into @jarvis/core:
 *  1. A chat turn gets captured (user + assistant).
 *  2. Retrieved memories are injected into the assembled prompt.
 *  3. The procedural block is loaded (when available).
 *  4. Chat degrades gracefully when the memory system throws.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";

import { ChatCore } from "../src/chat/chatCore.js";
import { InMemoryConversationStore } from "../src/chat/conversationStore.js";
import { assemblePrompt } from "../src/chat/promptAssembler.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTempMemory() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-core-memory-test-"));
  const embedder = new FakeEmbedder();
  const llm = new FakeLlm();
  return createMemorySystem({ embedder, llm, dataDir: dir });
}

/**
 * Minimal stub of InferenceGateway that streams a canned reply.
 * ChatCore only calls: gateway.chat(), gateway.registry.defaultFor(), gateway.modelManager.isFallbackActive()
 */
function makeGatewayStub(reply = "Hello from Jarvis"): {
  gateway: InstanceType<typeof import("../src/inference/gateway.js").InferenceGateway>;
} {
  const gateway = {
    chat: async function* (_req: unknown, _signal?: AbortSignal) {
      yield { type: "token" as const, text: reply };
      yield { type: "done" as const };
    },
    registry: {
      defaultFor: (_kind: string, _target: string) => ({
        ctxWindow: 16_384,
        id: "test-model",
        modelRef: "test",
        kind: "chat",
        provider: "mlx",
      }),
    },
    modelManager: {
      isFallbackActive: () => false,
    },
    mlx: {
      embed: async (_modelRef: string, texts: string[]) => texts.map(() => Array(256).fill(0)),
    },
  } as unknown as InstanceType<typeof import("../src/inference/gateway.js").InferenceGateway>;

  return { gateway };
}

/** Consume an async generator into an array. */
async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("memory-integration: capture", () => {
  it("a completed chat turn captures the user and assistant messages", async () => {
    const memory = makeTempMemory();
    const { gateway } = makeGatewayStub("Test reply");
    const store = new InMemoryConversationStore();

    const core = new ChatCore(gateway, store, memory);
    const events = await drain(core.send({ message: "What is TypeScript?" }));

    // Verify the turn completed
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();

    // Give the fire-and-forget capture a tick to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The memory store should have captured both user + assistant messages
    const pending = memory.store.getPendingExperienceRecords();
    expect(pending.length).toBeGreaterThanOrEqual(2);

    const roles = pending.map((r) => r.actor);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");

    // The capture adapter prefixes text with "[role] content"
    const userRecord = pending.find((r) => r.actor === "user");
    expect(userRecord?.text).toContain("What is TypeScript?");

    const assistantRecord = pending.find((r) => r.actor === "assistant");
    expect(assistantRecord?.text).toContain("Test reply");
  });

  it("capture does not fail the chat turn even when capture throws", async () => {
    const memory = makeTempMemory();

    // Make captureConversationTurn throw
    vi.spyOn(memory.capture, "captureConversationTurn").mockRejectedValue(
      new Error("capture DB error"),
    );

    const { gateway } = makeGatewayStub();
    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);

    // Should complete without throwing
    const events = await drain(core.send({ message: "Hello" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });
});

describe("memory-integration: retrieval injection", () => {
  it("retrieved memories are present in the assembled prompt", async () => {
    const memory = makeTempMemory();

    // Seed a note so retrieval has something to return
    await memory.capture.captureNote({
      text: "User prefers TypeScript over JavaScript",
      noteId: "note-ts-pref",
      tags: ["preferences"],
    });

    // Stub retrieval to return a known memory
    vi.spyOn(memory.retrieval, "retrieve").mockResolvedValue([
      {
        memoryId: "mem-1",
        text: "User prefers TypeScript over JavaScript",
        kind: "fact" as const,
        fusedScore: 0.9,
        scoreBreakdown: {
          recency: 0.8,
          importance: 0.9,
          relevance: 0.9,
          signals: { vector: 0.9, bm25: 0.8, entity: 0.7 },
        },
        placementHint: "edge_top" as const,
        validFrom: Date.now(),
        rank: 1,
      },
    ]);

    const { gateway } = makeGatewayStub();
    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);

    // Intercept gateway.chat to capture the assembled messages
    let capturedMessages: { role: string; content: string }[] = [];
    const origChat = gateway.chat.bind(gateway);
    vi.spyOn(gateway, "chat").mockImplementation(async function* (req: unknown) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: "ok" };
      yield { type: "done" as const };
    });

    await drain(core.send({ message: "Do you remember my preferences?" }));

    // The memory block should appear in one of the system messages
    const allContent = capturedMessages.map((m) => m.content).join("\n");
    expect(allContent).toContain("TypeScript over JavaScript");
    expect(allContent).toContain("Relevant memories");
  });

  it("retrieved memories appear at prompt edges (top memory abuts history)", async () => {
    // This tests the assembler directly with memory data shaped like retrieval output
    const memories = [
      {
        id: "mem-weak",
        tier: "semantic" as const,
        text: "Weak memory",
        score: 0.3,
        sourceRef: "mem-weak",
      },
      {
        id: "mem-strong",
        tier: "episodic" as const,
        text: "Strong memory",
        score: 0.9,
        sourceRef: "mem-strong",
      },
    ];

    const assembled = assemblePrompt({
      procedural: "",
      memories,
      history: [],
      userMessage: "test query",
      contextWindow: 16_384,
      mode: "local",
      now: new Date(),
    });

    // Both memories should appear
    const memBlock = assembled.messages.find(
      (m) => m.role === "system" && m.content.includes("Relevant memories"),
    );
    expect(memBlock).toBeDefined();
    expect(memBlock?.content).toContain("Weak memory");
    expect(memBlock?.content).toContain("Strong memory");

    // The memory block should come BEFORE the user message (edge placement)
    const memIdx = assembled.messages.findIndex(
      (m) => m.role === "system" && m.content.includes("Relevant memories"),
    );
    const userIdx = assembled.messages.findIndex(
      (m) => m.role === "user",
    );
    expect(memIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(memIdx);

    // Injected array should match (weak first, then strong in ascending order)
    expect(assembled.injected.length).toBe(2);
    expect(assembled.injected[0]?.text).toBe("Weak memory");
    expect(assembled.injected[1]?.text).toBe("Strong memory");
  });
});

describe("memory-integration: procedural block", () => {
  it("procedural block is loaded from memory and placed in the system prompt", async () => {
    const memory = makeTempMemory();

    // Stub getProceduralBlock to return a known block
    vi.spyOn(memory.retrieval, "getProceduralBlock").mockReturnValue(
      "- Prefer TypeScript.\n- Morning deep work.",
    );

    let capturedMessages: { role: string; content: string }[] = [];
    const { gateway } = makeGatewayStub();
    vi.spyOn(gateway, "chat").mockImplementation(async function* (req: unknown) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: "ok" };
      yield { type: "done" as const };
    });

    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);
    await drain(core.send({ message: "What are my work habits?" }));

    const systemMsg = capturedMessages.find((m) => m.role === "system");
    expect(systemMsg?.content).toContain("How I work");
    expect(systemMsg?.content).toContain("Morning deep work");
  });

  it("chat works normally when getProceduralBlock returns empty string", async () => {
    const memory = makeTempMemory();
    vi.spyOn(memory.retrieval, "getProceduralBlock").mockReturnValue("");

    const { gateway } = makeGatewayStub("fine");
    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);

    const events = await drain(core.send({ message: "Hello" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });
});

describe("memory-integration: graceful degradation", () => {
  it("chat works when memory system is null (no memory configured)", async () => {
    const { gateway } = makeGatewayStub("Hi there");
    const store = new InMemoryConversationStore();
    // Pass null for memory — feature degrades gracefully
    const core = new ChatCore(gateway, store, null);

    const events = await drain(core.send({ message: "Hello" }));
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThan(0);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  it("chat works when retrieval throws an error", async () => {
    const memory = makeTempMemory();
    vi.spyOn(memory.retrieval, "retrieve").mockRejectedValue(
      new Error("vector store unavailable"),
    );

    const { gateway } = makeGatewayStub("ok even without memories");
    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);

    // Should complete without surfacing an error event
    const events = await drain(core.send({ message: "Tell me something" }));
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  it("chat works when getProceduralBlock throws", async () => {
    const memory = makeTempMemory();
    vi.spyOn(memory.retrieval, "getProceduralBlock").mockImplementation(() => {
      throw new Error("procedural store unavailable");
    });

    const { gateway } = makeGatewayStub("fine");
    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);

    const events = await drain(core.send({ message: "Hello" }));
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
  });

  it("empty retrieval produces the grounding note instead of memory bullets", async () => {
    const memory = makeTempMemory();
    vi.spyOn(memory.retrieval, "retrieve").mockResolvedValue([]);
    vi.spyOn(memory.retrieval, "getProceduralBlock").mockReturnValue("");

    let capturedMessages: { role: string; content: string }[] = [];
    const { gateway } = makeGatewayStub();
    vi.spyOn(gateway, "chat").mockImplementation(async function* (req: unknown) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: "ok" };
      yield { type: "done" as const };
    });

    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, memory);
    await drain(core.send({ message: "Hi" }));

    // Memory is wired but recall came up empty: the prompt carries an explicit
    // "nothing stored" note so the model doesn't invent personal details.
    const memBlock = capturedMessages.find(
      (m) => m.content.includes("Relevant memories"),
    );
    expect(memBlock).toBeDefined();
    expect(memBlock?.content).toContain("None found for this message");
    expect(memBlock?.content).not.toContain("\n- ");
  });

  it("no memory system at all produces no memory block (no wasted tokens)", async () => {
    let capturedMessages: { role: string; content: string }[] = [];
    const { gateway } = makeGatewayStub();
    vi.spyOn(gateway, "chat").mockImplementation(async function* (req: unknown) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: "ok" };
      yield { type: "done" as const };
    });

    const store = new InMemoryConversationStore();
    const core = new ChatCore(gateway, store, null);
    await drain(core.send({ message: "Hi" }));

    const memBlock = capturedMessages.find(
      (m) => m.content.includes("Relevant memories"),
    );
    expect(memBlock).toBeUndefined();
  });
});
