/**
 * prompt-grounding.test.ts
 *
 * Anti-hallucination grounding: Jarvis may only state personal facts that come
 * from its memory stores / connected-app context injected into the prompt.
 *  1. The persona carries the standing grounding rules (and is versioned).
 *  2. The assembler emits a "nothing stored" note when a memory system is
 *     wired but retrieval found nothing — and stays silent when none is wired.
 *  3. Retrieval errors degrade to the same safe "nothing stored" note.
 */

import { describe, it, expect, vi } from "vitest";

import { assemblePrompt } from "../src/chat/promptAssembler.js";
import { PERSONA_SYSTEM_PROMPT, PERSONA_VERSION } from "../src/chat/persona.js";
import { ChatCore } from "../src/chat/chatCore.js";
import { InMemoryConversationStore } from "../src/chat/conversationStore.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";

function makeTempMemory() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-grounding-test-"));
  return createMemorySystem({ embedder: new FakeEmbedder(), llm: new FakeLlm(), dataDir: dir });
}

function makeGatewayStub() {
  let capturedMessages: { role: string; content: string }[] = [];
  const gateway = {
    chat: async function* (req: unknown) {
      capturedMessages = (req as { messages: { role: string; content: string }[] }).messages;
      yield { type: "token" as const, text: "ok" };
      yield { type: "done" as const };
    },
    registry: {
      defaultFor: () => ({ ctxWindow: 16_384, id: "test", modelRef: "test", kind: "chat", provider: "mlx" }),
    },
    modelManager: { isFallbackActive: () => false },
  } as unknown as InstanceType<typeof import("../src/inference/gateway.js").InferenceGateway>;
  return { gateway, messages: () => capturedMessages };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe("persona grounding rules", () => {
  it("persona is versioned past v1 and forbids inventing personal facts", () => {
    expect(PERSONA_VERSION).not.toBe("v1");
    expect(PERSONA_SYSTEM_PROMPT).toContain("Never invent");
    expect(PERSONA_SYSTEM_PROMPT).toContain("memory and context blocks");
    expect(PERSONA_SYSTEM_PROMPT).toContain("offer to look it up");
  });

  it("connected apps are named as a grounded source", () => {
    for (const app of ["calendar", "health", "email", "finance", "todos"]) {
      expect(PERSONA_SYSTEM_PROMPT).toContain(app);
    }
  });
});

describe("assembler grounding note", () => {
  const base = {
    procedural: "",
    history: [],
    userMessage: "What's my dog's name?",
    contextWindow: 16_384,
    mode: "local" as const,
    now: new Date("2026-06-10T12:00:00Z"),
  };

  it("memoryAvailable + zero memories -> explicit 'nothing stored' note", () => {
    const assembled = assemblePrompt({ ...base, memories: [], memoryAvailable: true });
    const memBlock = assembled.messages.find((m) => m.content.includes("Relevant memories"));
    expect(memBlock).toBeDefined();
    expect(memBlock?.content).toContain("None found for this message");
    expect(memBlock?.content).toContain("isn't stored");
    expect(assembled.injected).toHaveLength(0);
  });

  it("no memory system -> no memory block at all", () => {
    const assembled = assemblePrompt({ ...base, memories: [], memoryAvailable: false });
    expect(assembled.messages.some((m) => m.content.includes("Relevant memories"))).toBe(false);
  });

  it("memories present -> bullets, not the empty note", () => {
    const assembled = assemblePrompt({
      ...base,
      memoryAvailable: true,
      memories: [
        { id: "m1", tier: "semantic", text: "Dog is named Rex", score: 0.9, sourceRef: "m1" },
      ],
    });
    const memBlock = assembled.messages.find((m) => m.content.includes("Relevant memories"));
    expect(memBlock?.content).toContain("Dog is named Rex");
    expect(memBlock?.content).not.toContain("None found");
  });
});

describe("ChatCore wiring", () => {
  it("retrieval error degrades to the safe 'nothing stored' note", async () => {
    const memory = makeTempMemory();
    vi.spyOn(memory.retrieval, "retrieve").mockRejectedValue(new Error("store down"));
    vi.spyOn(memory.retrieval, "getProceduralBlock").mockReturnValue("");

    const { gateway, messages } = makeGatewayStub();
    const core = new ChatCore(gateway, new InMemoryConversationStore(), memory);
    const events = await drain(core.send({ message: "Where do I live?" }));

    expect(events.some((e) => e.type === "error")).toBe(false);
    const memBlock = messages().find((m) => m.content.includes("Relevant memories"));
    expect(memBlock?.content).toContain("None found for this message");
  });

  it("every assembled prompt starts with the grounded persona", async () => {
    const { gateway, messages } = makeGatewayStub();
    const core = new ChatCore(gateway, new InMemoryConversationStore(), null);
    await drain(core.send({ message: "Hello" }));

    const first = messages()[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toContain("Never invent");
  });
});
