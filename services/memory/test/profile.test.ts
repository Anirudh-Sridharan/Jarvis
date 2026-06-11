/**
 * Tests for ProfileService — feature 20.
 *
 * Covers:
 * - deriveProfile: correct facet grouping from seeded facts
 * - correctFact: invalidates old fact (valid_to set), inserts corrected fact, facet updates
 * - getProfile: returns cached/derived profile
 * - forgetEntity: invalidates all live facts for an entity
 * - Procedural block included in derived profile
 * - Deterministic fallback works without LLM (no llm injected)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";
import { ProfileService } from "../src/profile/profile.js";

// ── Test factory ──────────────────────────────────────────────────────────────

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-profile-test-"));
  const db = openDatabase(dir);
  const embedder = new FakeEmbedder();
  const store = new MemoryStore(db, embedder);
  return { store, dir };
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedPreferenceFact(store: MemoryStore, objectLiteral: string) {
  // Seed an entity "self" for subject
  const entity = await store.upsertEntity({
    name: "self",
    entityType: "other",
    text: "The user themselves",
    provenance: { source: "system", sourceId: "seed", confidence: 1 },
  });

  return store.upsertFact({
    subjectId: entity.id,
    predicate: "prefers",
    objectLiteral,
    text: `User prefers ${objectLiteral}`,
    validFrom: new Date().toISOString(),
    provenance: { source: "chat", sourceId: "msg-1", confidence: 0.9 },
  });
}

async function seedPersonEntity(store: MemoryStore, name: string) {
  return store.upsertEntity({
    name,
    entityType: "person",
    text: `Person: ${name}`,
    provenance: { source: "chat", sourceId: "person-seed", confidence: 0.8 },
  });
}

async function seedProjectEntity(store: MemoryStore, name: string) {
  return store.upsertEntity({
    name,
    entityType: "project",
    text: `Project: ${name}`,
    provenance: { source: "chat", sourceId: "project-seed", confidence: 0.8 },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProfileService - deriveProfile (deterministic fallback, no LLM)", () => {
  it("returns an empty profile when no facts exist", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store); // no LLM injected

    const profile = await svc.deriveProfile();

    expect(profile.preferences).toHaveLength(0);
    expect(profile.people).toHaveLength(0);
    expect(profile.projects).toHaveLength(0);
    expect(profile.routines).toHaveLength(0);
    expect(profile.communicationStyle).toHaveLength(0);
    expect(profile.proceduralBlock).toBe("");
    expect(profile.version).toBeGreaterThan(0);
    expect(profile.updatedAt).toBeTruthy();
  });

  it("groups preference facts into preferences facet", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store); // no LLM

    await seedPreferenceFact(store, "TypeScript");
    await seedPreferenceFact(store, "dark mode");

    const profile = await svc.deriveProfile();

    expect(profile.preferences.length).toBeGreaterThanOrEqual(2);
    const values = profile.preferences.map((p) => p.value);
    expect(values).toContain("TypeScript");
    expect(values).toContain("dark mode");
  });

  it("groups person-typed entity facts into people facet", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const person = await seedPersonEntity(store, "Alice");
    await store.upsertFact({
      subjectId: person.id,
      predicate: "relationship_is",
      objectLiteral: "colleague",
      text: "Alice is a colleague",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "msg-2", confidence: 0.8 },
    });

    const profile = await svc.deriveProfile();

    expect(profile.people.length).toBeGreaterThanOrEqual(1);
    const aliceFact = profile.people.find((p) => p.value.name === "alice"); // normalized
    expect(aliceFact).toBeTruthy();
  });

  it("groups project-typed entity facts into projects facet", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const project = await seedProjectEntity(store, "Jarvis");
    await store.upsertFact({
      subjectId: project.id,
      predicate: "status_is",
      objectLiteral: "active",
      text: "Jarvis project is active",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "msg-3", confidence: 0.9 },
    });

    const profile = await svc.deriveProfile();

    expect(profile.projects.length).toBeGreaterThanOrEqual(1);
    const jarvis = profile.projects.find((p) => p.value.name === "jarvis");
    expect(jarvis).toBeTruthy();
    expect(jarvis!.value.status).toBe("active");
  });

  it("groups routine predicates into routines facet", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const entity = await store.upsertEntity({
      name: "self",
      entityType: "other",
      text: "self",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });

    await store.upsertFact({
      subjectId: entity.id,
      predicate: "habit_is",
      objectLiteral: "deep work mornings",
      text: "User habit is deep work mornings",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "msg-4", confidence: 0.8 },
    });

    const profile = await svc.deriveProfile();

    expect(profile.routines.length).toBeGreaterThanOrEqual(1);
    const routine = profile.routines[0]!;
    expect(routine.value.description).toBe("deep work mornings");
  });

  it("includes procedural block when present", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    store.writeProceduralBlock(
      "## How I Work\n\n- Deep work mornings.\n",
      [],
      "feature-6",
    );

    const profile = await svc.deriveProfile();

    expect(profile.proceduralBlock).toContain("Deep work mornings");
  });

  it("getProceduralBlock() passthrough returns procedural markdown", () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    store.writeProceduralBlock("## My workflow\n\n- Ship fast.", [], "feature-6");

    expect(svc.getProceduralBlock()).toContain("Ship fast");
  });
});

describe("ProfileService - deriveProfile with FakeLlm", () => {
  it("uses LLM to summarize person notes (graceful fallback on error)", async () => {
    const { store } = makeStore();
    const llm = new FakeLlm();
    const svc = new ProfileService(store, llm);

    const person = await seedPersonEntity(store, "Bob");
    await store.upsertFact({
      subjectId: person.id,
      predicate: "notes_is",
      objectLiteral: "helpful",
      text: "Bob is helpful",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "msg-5", confidence: 0.7 },
    });

    const profile = await svc.deriveProfile();
    // Should have a person entry for Bob regardless of LLM outcome
    expect(profile.people.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ProfileService - getProfile (cache)", () => {
  it("returns the same profile object on second call", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    await seedPreferenceFact(store, "Vim");

    const p1 = await svc.getProfile();
    const p2 = await svc.getProfile(); // should be cached
    expect(p2).toBe(p1); // same reference
  });

  it("reflects facts after correctFact clears cache", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const fact = await seedPreferenceFact(store, "Vim");
    const p1 = await svc.getProfile();

    expect(p1.preferences.map((x) => x.value)).toContain("Vim");

    // Correct the preference
    const p2 = await svc.correctFact({ factId: fact.id, correction: "Emacs" });
    const values = p2.preferences.map((x) => x.value);

    // Old value should be gone, new value should be present
    expect(values).not.toContain("Vim");
    expect(values).toContain("Emacs");
  });
});

describe("ProfileService - correctFact (invalidation loop)", () => {
  it("invalidates the old fact and the new fact appears in the store", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const fact = await seedPreferenceFact(store, "JavaScript");

    // Verify fact is live before correction
    const before = store.getFactById(fact.id)!;
    expect(before.invalidatedAt).toBeNull();
    expect(before.validTo).toBeNull();

    // Apply correction
    await svc.correctFact({ factId: fact.id, correction: "TypeScript" });

    // Old fact must now be invalidated (validTo set)
    const after = store.getFactById(fact.id)!;
    expect(after.validTo).not.toBeNull();
    expect(after.invalidatedAt).not.toBeNull();

    // A new fact with objectLiteral="TypeScript" should exist as a live fact
    const liveFacts = store.getFactHistory(fact.subjectId, "prefers");
    const live = liveFacts.filter((f) => f.invalidatedAt === null && f.validTo === null);
    expect(live.length).toBe(1);
    expect(live[0]!.objectLiteral).toBe("TypeScript");
    expect(live[0]!.supersedes).toBe(fact.id);
  });

  it("new fact from correctFact has source_trust=1.0 (user-authoritative)", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const fact = await seedPreferenceFact(store, "Python");
    await svc.correctFact({ factId: fact.id, correction: "Go" });

    const liveFacts = store.getFactHistory(fact.subjectId, "prefers");
    const live = liveFacts.filter((f) => f.invalidatedAt === null && f.validTo === null);
    expect(live.length).toBe(1);
    expect(live[0]!.provenance.confidence).toBe(1.0);
  });

  it("throws if factId does not exist", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    await expect(
      svc.correctFact({ factId: "nonexistent-fact-id", correction: "whatever" }),
    ).rejects.toThrow("not found");
  });

  it("facet updates after correctFact reflect the correction", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const fact = await seedPreferenceFact(store, "MySQL");
    const profile = await svc.correctFact({ factId: fact.id, correction: "PostgreSQL" });

    const prefs = profile.preferences.map((p) => p.value);
    expect(prefs).not.toContain("MySQL");
    expect(prefs).toContain("PostgreSQL");
  });
});

describe("ProfileService - forgetEntity", () => {
  it("invalidates all live facts for the named entity", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    const person = await seedPersonEntity(store, "Carol");
    const f1 = await store.upsertFact({
      subjectId: person.id,
      predicate: "relationship_is",
      objectLiteral: "manager",
      text: "Carol is manager",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "m1", confidence: 0.8 },
    });
    const f2 = await store.upsertFact({
      subjectId: person.id,
      predicate: "notes_is",
      objectLiteral: "helpful",
      text: "Carol is helpful",
      validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "m2", confidence: 0.7 },
    });

    await svc.forgetEntity({ entityName: "Carol" });

    // Both facts should be invalidated
    const f1After = store.getFactById(f1.id)!;
    const f2After = store.getFactById(f2.id)!;
    expect(f1After.validTo).not.toBeNull();
    expect(f2After.validTo).not.toBeNull();

    // Profile people facet should not include Carol
    const profile = await svc.getProfile();
    const carolInPeople = profile.people.find((p) => p.value.name === "carol");
    expect(carolInPeople).toBeUndefined();
  });

  it("is a no-op for an unknown entity name", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    // Should not throw
    await expect(svc.forgetEntity({ entityName: "NoSuchPerson" })).resolves.toBeTruthy();
  });
});

describe("ProfileService - correctFact is failure-safe (insert before invalidate)", () => {
  it("keeps the original fact live when inserting the replacement fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-profile-failsafe-"));
    const db = openDatabase(dir);
    // Embedder that fails — simulates the network embed call going down
    const throwingEmbedder = {
      embed: async (_texts: string[]): Promise<number[][]> => {
        throw new Error("embedder down");
      },
    };
    const store = new MemoryStore(db, throwingEmbedder);

    // Seed with an explicit embedding so the seed itself doesn't need the embedder
    const fact = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "Vim",
      text: "prefers: Vim",
      validFrom: "2026-01-01T00:00:00Z",
      embedding: [0.1, 0.2, 0.3],
      provenance: { source: "chat", sourceId: "seed-1", confidence: 0.9 },
    });

    const svc = new ProfileService(store);
    await expect(
      svc.correctFact({ factId: fact.id, correction: "Emacs" }),
    ).rejects.toThrow();

    // The user's fact must NOT be gone: still live, no invalidation recorded
    const original = store.getFactById(fact.id)!;
    expect(original.validTo).toBeNull();
    expect(original.invalidatedAt).toBeNull();
    expect(original.invalidatedBy).toBeNull();
  });
});

describe("ProfileService - ProfileFact shape", () => {
  it("each ProfileFact has id, value, confidence, source, updatedAt", async () => {
    const { store } = makeStore();
    const svc = new ProfileService(store);

    await seedPreferenceFact(store, "Next.js");
    const profile = await svc.deriveProfile();

    expect(profile.preferences.length).toBeGreaterThan(0);
    const pref = profile.preferences[0]!;
    expect(typeof pref.id).toBe("string");
    expect(typeof pref.value).toBe("string");
    expect(typeof pref.confidence).toBe("number");
    expect(["derived", "user"]).toContain(pref.source);
    expect(typeof pref.updatedAt).toBe("string");
  });
});

describe("ProfileService - conflict surfacing", () => {
  it("two live facts on the same subject+predicate with different values are cross-flagged", async () => {
    const { store } = makeStore();
    const entity = await store.upsertEntity({
      name: "self", entityType: "other", text: "The user",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });
    const a = await store.upsertFact({
      subjectId: entity.id, predicate: "prefers", objectLiteral: "vim",
      text: "User prefers vim", validFrom: "2026-01-01T00:00:00.000Z",
      provenance: { source: "chat", sourceId: "m1", confidence: 0.8 },
    });
    const b = await store.upsertFact({
      subjectId: entity.id, predicate: "prefers", objectLiteral: "emacs",
      text: "User prefers emacs", validFrom: "2026-02-01T00:00:00.000Z",
      provenance: { source: "chat", sourceId: "m2", confidence: 0.7 },
    });

    const profile = await new ProfileService(store).deriveProfile();
    const fa = profile.preferences.find((f) => f.id === a.id)!;
    const fb = profile.preferences.find((f) => f.id === b.id)!;
    expect(fa.conflictsWith).toEqual([b.id]);
    expect(fb.conflictsWith).toEqual([a.id]);
  });

  it("same-value duplicates are not flagged", async () => {
    const { store } = makeStore();
    const entity = await store.upsertEntity({
      name: "self", entityType: "other", text: "The user",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });
    await store.upsertFact({
      subjectId: entity.id, predicate: "prefers", objectLiteral: "Vim",
      text: "User prefers Vim", validFrom: "2026-01-01T00:00:00.000Z",
      provenance: { source: "chat", sourceId: "m1", confidence: 0.8 },
    });
    await store.upsertFact({
      subjectId: entity.id, predicate: "prefers", objectLiteral: "vim ",
      text: "User prefers vim", validFrom: "2026-02-01T00:00:00.000Z",
      provenance: { source: "chat", sourceId: "m2", confidence: 0.7 },
    });
    const profile = await new ProfileService(store).deriveProfile();
    for (const f of profile.preferences) expect(f.conflictsWith).toBeUndefined();
  });

  it("'summary' compression facts are exempt from conflict flagging", async () => {
    const { store } = makeStore();
    const entity = await store.upsertEntity({
      name: "self", entityType: "other", text: "The user",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });
    await store.upsertFact({
      subjectId: entity.id, predicate: "summary", objectLiteral: "summary one",
      text: "summary one", validFrom: "2026-01-01T00:00:00.000Z",
      provenance: { source: "consolidation", sourceId: "c1", confidence: 0.6 },
    });
    await store.upsertFact({
      subjectId: entity.id, predicate: "summary", objectLiteral: "summary two",
      text: "summary two", validFrom: "2026-02-01T00:00:00.000Z",
      provenance: { source: "consolidation", sourceId: "c2", confidence: 0.6 },
    });
    const profile = await new ProfileService(store).deriveProfile();
    const flagged = [
      ...profile.preferences, ...profile.routines, ...profile.communicationStyle,
    ].filter((f) => f.conflictsWith);
    expect(flagged).toHaveLength(0);
  });
});
