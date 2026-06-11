/**
 * Feature 20 — pin persistence tests.
 *
 * Pins live on the facts table (they ride the bi-temporal lifecycle), survive
 * re-derivation across ProfileService instances, and the schema migration is
 * idempotent on pre-pin databases.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { applySchema } from "../src/db/schema.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder } from "../src/testing/fakes.js";
import { ProfileService } from "../src/profile/profile.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-pins-test-"));
  const db = openDatabase(dir);
  return { store: new MemoryStore(db, new FakeEmbedder()), db };
}

async function seedFact(store: MemoryStore, objectLiteral = "dark roast") {
  const entity = await store.upsertEntity({
    name: "self",
    entityType: "other",
    text: "The user",
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

describe("pinned column", () => {
  it("defaults to false on insert and round-trips through rowToFact", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    expect(fact.pinned).toBe(false);
  });

  it("upsertFact persists pinned: true", async () => {
    const { store } = makeStore();
    const entity = await store.upsertEntity({
      name: "self",
      entityType: "other",
      text: "The user",
      provenance: { source: "system", sourceId: "seed", confidence: 1 },
    });
    const fact = await store.upsertFact({
      subjectId: entity.id,
      predicate: "prefers",
      objectLiteral: "tea",
      text: "User prefers tea",
      validFrom: new Date().toISOString(),
      pinned: true,
      provenance: { source: "system", sourceId: "user-correction", confidence: 1 },
    });
    expect(fact.pinned).toBe(true);
    expect(store.getFactById(fact.id)?.pinned).toBe(true);
  });

  it("setFactPinned toggles and persists; returns null for unknown id", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    expect(store.setFactPinned(fact.id, true)?.pinned).toBe(true);
    expect(store.getFactById(fact.id)?.pinned).toBe(true);
    expect(store.setFactPinned(fact.id, false)?.pinned).toBe(false);
    expect(store.setFactPinned("nope", true)).toBeNull();
  });

  it("migration is idempotent and upgrades a pre-pin facts table", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-pins-mig-"));
    const db = openDatabase(dir);
    // Simulate a pre-pin database: drop the column, then re-apply the schema.
    db.exec(`ALTER TABLE facts DROP COLUMN pinned`);
    applySchema(db); // must add it back
    applySchema(db); // and be a no-op the second time
    const cols = db.prepare(`PRAGMA table_info(facts)`).all() as { name: string }[];
    expect(cols.some((c) => c.name === "pinned")).toBe(true);
  });
});

describe("ProfileService pin behavior", () => {
  it("derivation reflects the persisted pin", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    store.setFactPinned(fact.id, true);
    const svc = new ProfileService(store);
    const profile = await svc.deriveProfile();
    expect(profile.preferences.find((f) => f.id === fact.id)?.pinned).toBe(true);
  });

  it("setPinned persists across a fresh ProfileService instance", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    await new ProfileService(store).setPinned(fact.id, true);
    const fresh = await new ProfileService(store).deriveProfile();
    expect(fresh.preferences.find((f) => f.id === fact.id)?.pinned).toBe(true);
  });

  it("editFacet with a pinned update persists (not cache-only)", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    const svc = new ProfileService(store);
    await svc.deriveProfile();
    await svc.editFacet({ facet: "preferences", factId: fact.id, updates: { pinned: true } });
    expect(store.getFactById(fact.id)?.pinned).toBe(true);
  });

  it("correctFact births the replacement pinned with source 'user'", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    const svc = new ProfileService(store);
    const profile = await svc.correctFact({ factId: fact.id, correction: "light roast" });
    const corrected = profile.preferences.find((f) => f.value.includes("light roast"));
    expect(corrected).toBeDefined();
    expect(corrected!.pinned).toBe(true);
    expect(corrected!.source).toBe("user");
  });

  it("setPinned throws on unknown fact id", async () => {
    const { store } = makeStore();
    await expect(new ProfileService(store).setPinned("nope", true)).rejects.toThrow(/not found/);
  });
});

describe("review fixes", () => {
  it("setFactPinned refuses an invalidated fact (liveness guard)", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    store.invalidateFact({
      factId: fact.id,
      validTo: new Date().toISOString(),
      reason: "test",
    });
    expect(store.setFactPinned(fact.id, true)).toBeNull();
  });

  it("Confirm on a person card pins the whole entity group, not just the anchor", async () => {
    const { store } = makeStore();
    const person = await store.upsertEntity({
      name: "Maya",
      entityType: "person",
      text: "Person: Maya",
      provenance: { source: "chat", sourceId: "p1", confidence: 0.8 },
    });
    const f1 = await store.upsertFact({
      subjectId: person.id, predicate: "relationship_is", objectLiteral: "manager",
      text: "Maya is the user's manager", validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "m1", confidence: 0.9 },
    });
    const f2 = await store.upsertFact({
      subjectId: person.id, predicate: "works_at", objectLiteral: "Acme",
      text: "Maya works at Acme", validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "m2", confidence: 0.7 },
    });

    const svc = new ProfileService(store);
    const profile = await svc.deriveProfile();
    const anchorId = profile.people[0]!.id;
    await svc.setPinned(anchorId, true);

    expect(store.getFactById(f1.id)?.pinned).toBe(true);
    expect(store.getFactById(f2.id)?.pinned).toBe(true);

    await svc.setPinned(anchorId, false);
    expect(store.getFactById(f1.id)?.pinned).toBe(false);
    expect(store.getFactById(f2.id)?.pinned).toBe(false);
  });

  it("forgetFact closes out a single fact bi-temporally and drops it from the profile", async () => {
    const { store } = makeStore();
    const keep = await seedFact(store, "dark roast");
    const drop = await store.upsertFact({
      subjectId: keep.subjectId, predicate: "likes", objectLiteral: "jazz",
      text: "User likes jazz", validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "m9", confidence: 0.8 },
    });

    const svc = new ProfileService(store);
    const after = await svc.forgetFact(drop.id);

    expect(after.preferences.find((f) => f.id === drop.id)).toBeUndefined();
    expect(after.preferences.find((f) => f.id === keep.id)).toBeDefined();
    const closed = store.getFactById(drop.id)!;
    expect(closed.invalidatedAt).not.toBeNull(); // soft delete, never hard
    await expect(svc.forgetFact("nope")).rejects.toThrow(/not found/);
  });

  it("editFacet rejects object-value edits instead of silently caching them", async () => {
    const { store } = makeStore();
    const fact = await seedFact(store);
    const svc = new ProfileService(store);
    await svc.deriveProfile();
    await expect(
      svc.editFacet({
        facet: "people",
        factId: fact.id,
        updates: { value: { name: "X" } as never },
      }),
    ).rejects.toThrow(/not supported/);
  });

  it("getProfileContext does not clobber the cached profile or bump the version", async () => {
    const { store } = makeStore();
    await seedFact(store);
    const svc = new ProfileService(store);
    const cached = await svc.deriveProfile();
    const versionBefore = cached.version;

    await svc.getProfileContext("coffee");
    await svc.getProfileContext("coffee again");

    const after = await svc.getProfile();
    expect(after).toBe(cached); // same object — cache untouched
    expect(after.version).toBe(versionBefore);
  });
});
