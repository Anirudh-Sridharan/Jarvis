/**
 * Feature 20 — query-relevant profile facets injected into the chat prompt.
 *
 *  1. The assembler renders the profile block in the system message, under the
 *     procedural "## How I work" block, and budgets it.
 *  2. An empty block is omitted entirely (no scaffolding, zero budget).
 *  3. capProfile enforces the hard token cap.
 *  4. ChatCore loads the block from memory.profile.getProfileContext per turn.
 *  5. A throwing profile degrades to no block — never fails the turn.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assemblePrompt } from "../src/chat/promptAssembler.js";
import { capProfile, PROFILE_CAP } from "../src/chat/contextBudget.js";
import { ChatCore } from "../src/chat/chatCore.js";
import { InMemoryConversationStore } from "../src/chat/conversationStore.js";
import { createMemorySystem } from "@jarvis/memory";
import { FakeEmbedder, FakeLlm } from "@jarvis/memory/testing";
import { makeGatewayStub, drain } from "./chatTestKit.js";

const NOW = new Date("2026-06-11T12:00:00.000Z");

function makeTempMemory() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-profile-inject-test-"));
  return createMemorySystem({ embedder: new FakeEmbedder(), llm: new FakeLlm(), dataDir: dir });
}

describe("assembler profile block", () => {
  const base = {
    procedural: "Be concise.",
    memories: [],
    history: [],
    userMessage: "hi",
    contextWindow: 16_384,
    mode: "local" as const,
    now: NOW,
  };

  it("renders the profile block under the procedural block in the system message", () => {
    const out = assemblePrompt({
      ...base,
      profileContext: "## About the user\n- Preference: dark roast coffee",
    });
    const system = out.messages[0]!.content;
    expect(system).toContain("## About the user");
    expect(system).toContain("dark roast coffee");
    expect(system.indexOf("## How I work")).toBeLessThan(system.indexOf("## About the user"));
    expect(out.budget.profile).toBeGreaterThan(0);
  });

  it("omits the block when empty and reports zero budget", () => {
    const out = assemblePrompt({ ...base, procedural: "" });
    expect(out.messages[0]!.content).not.toContain("About the user");
    expect(out.budget.profile).toBe(0);
  });
});

describe("capProfile", () => {
  it("returns '' for empty input and truncates past PROFILE_CAP tokens", () => {
    expect(capProfile("")).toBe("");
    // Word-like text: ~1 token per word with the BPE estimator.
    const long = Array.from({ length: PROFILE_CAP * 2 }, (_, i) => `word${i}`).join(" ");
    const capped = capProfile(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped.length).toBe(PROFILE_CAP * 4);
    const short = "## About the user\n- Preference: tea";
    expect(capProfile(short)).toBe(short);
  });
});

describe("ChatCore profile wiring", () => {
  it("injects the query-relevant profile block into the system prompt", async () => {
    const memory = makeTempMemory();
    // Seed a preference fact so getProfileContext has something relevant.
    const entity = await memory.store.upsertEntity({
      name: "self",
      entityType: "other",
      text: "The user",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });
    await memory.store.upsertFact({
      subjectId: entity.id,
      predicate: "prefers",
      objectLiteral: "dark roast coffee",
      text: "User prefers dark roast coffee",
      validFrom: NOW.toISOString(),
      provenance: { source: "chat", sourceId: "m1", confidence: 0.9 },
    });

    const stub = makeGatewayStub();
    const core = new ChatCore(stub.gateway, new InMemoryConversationStore(), memory);
    await drain(core.send({ conversationId: "c1", message: "what coffee should I buy?" }));

    const system = stub.messages().find((m) => m.role === "system")!;
    expect(system.content).toContain("## About the user");
    expect(system.content).toContain("dark roast coffee");
  });

  it("degrades to no profile block when getProfileContext throws", async () => {
    const memory = makeTempMemory();
    memory.profile.getProfileContext = async () => {
      throw new Error("profile exploded");
    };

    const stub = makeGatewayStub();
    const core = new ChatCore(stub.gateway, new InMemoryConversationStore(), memory);
    const events = await drain(
      core.send({ conversationId: "c1", message: "hello there" }),
    );

    expect(events.some((e) => e.type === "error")).toBe(false);
    const system = stub.messages().find((m) => m.role === "system")!;
    expect(system.content).not.toContain("About the user");
  });
});
