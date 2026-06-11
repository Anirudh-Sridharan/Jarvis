# Feature 20 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four feature-20 gaps — persisted/enforced pins, query-relevant profile injection into chat, agent user-context, conflict surfacing — per `docs/superpowers/specs/2026-06-11-feature-20-profile-completion-design.md`.

**Architecture:** All profile logic stays deterministic in `@jarvis/memory` (`src/profile/`); consolidation enforcement lands in the existing resolve/forget stages; chat/agent consumption is wired in `@jarvis/core` via the existing DI seams (`MemorySystem.profile`, new injected `userContext` provider for the leaf `@jarvis/agent`); dashboard gets pin/conflict affordances through the existing BFF route.

**Tech Stack:** TypeScript ESM strict, `node:sqlite`, vitest (forks pool + node-sqlite shim), Next.js dashboard (typecheck only).

**Verification per package:** `npm test --workspace @jarvis/<pkg>`; dashboard: `cd apps/dashboard && npx tsc --noEmit -p tsconfig.json`. Run `@jarvis/core` tests after touching memory/agent (core depends on them). Build order for cross-package type changes: `npm run build --workspace @jarvis/memory` (and `@jarvis/agent`) before core's tests if core resolves workspace `dist` types.

---

### Task 1: `pinned` column — schema migration + store plumbing

**Files:**
- Modify: `services/memory/src/db/schema.ts` (facts DDL + `applySchema`)
- Modify: `services/memory/src/types.ts` (`Fact`)
- Modify: `services/memory/src/store/memoryStore.ts` (`FactInput`, `upsertFact`, `rowToFact`, `RawFact`, new `setFactPinned`)
- Test: `services/memory/test/profilePins.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
/**
 * Feature 20 — pin persistence tests.
 * Pins live on the facts table (bi-temporal lifecycle), survive re-derivation,
 * and the migration is idempotent on pre-pin databases.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { applySchema } from "../src/db/schema.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder } from "../src/testing/fakes.js";

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
      name: "self", entityType: "other", text: "The user",
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
    // Simulate a pre-pin database: drop the column by rebuilding the table.
    db.exec(`ALTER TABLE facts DROP COLUMN pinned`);
    applySchema(db); // must add it back
    applySchema(db); // and be a no-op the second time
    const cols = db.prepare(`PRAGMA table_info(facts)`).all() as { name: string }[];
    expect(cols.some((c) => c.name === "pinned")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd services/memory && npx vitest run test/profilePins.test.ts`
Expected: FAIL (`pinned` undefined / `setFactPinned` not a function).

- [ ] **Step 3: Implement**

`schema.ts` — in the facts DDL, after `source_trust REAL NOT NULL DEFAULT 0.5` add:

```sql
    source_trust REAL NOT NULL DEFAULT 0.5,
    -- User-confirmed pin (feature 20): consolidation must never supersede,
    -- evict, or compress a pinned fact. Only explicit user action clears it.
    pinned INTEGER NOT NULL DEFAULT 0
```

and extend `applySchema` with an idempotent column migration:

```ts
/** Idempotent ALTER TABLE migration for columns added after first release. */
function ensureColumn(
  db: import("node:sqlite").DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function applySchema(db: import("node:sqlite").DatabaseSync): void {
  for (const stmt of DDL) {
    db.exec(stmt);
  }
  // feature 20: pin column on pre-existing databases
  ensureColumn(db, "facts", "pinned", "pinned INTEGER NOT NULL DEFAULT 0");
}
```

`types.ts` — `Fact` gains (after `sourceTrust`):

```ts
  /** User-confirmed (feature 20): never auto-overwritten by consolidation. */
  pinned: boolean;
```

`memoryStore.ts`:
- `FactInput` gains `pinned?: boolean;`
- `upsertFact` INSERT adds the `pinned` column (19th): column list gains `pinned`, VALUES gains one `?`, run args gain `input.pinned ? 1 : 0` (placed last).
- `RawFact` gains `pinned: number;`, `rowToFact` gains `pinned: row.pinned === 1,`.
- New method after `invalidateFact`:

```ts
  /** Set/clear the user pin on a fact (feature 20). Returns null if not found. */
  setFactPinned(factId: string, pinned: boolean): Fact | null {
    const res = this.db
      .prepare(`UPDATE facts SET pinned = ? WHERE id = ?`)
      .run(pinned ? 1 : 0, factId);
    if (Number(res.changes) === 0) return null;
    return this.getFactById(factId);
  }
```

- [ ] **Step 4: Run tests**

Run: `cd services/memory && npx vitest run test/profilePins.test.ts` → PASS, then full `npx vitest run` (fixture facts now carry `pinned: false` — fix any equality-snapshot fallout).

- [ ] **Step 5: Commit** — `feat(memory): persisted pin column on facts (feature 20)`

---

### Task 2: ProfileService pins — derivation, born-pinned corrections, setPinned, editFacet persistence, user-source fix

**Files:**
- Modify: `services/memory/src/profile/profile.ts`
- Modify: `services/memory/src/profile/types.ts` (no change needed for pinned — already typed; verify)
- Test: `services/memory/test/profilePins.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (append to `profilePins.test.ts`; import `ProfileService` from `../src/profile/profile.js`)

```ts
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
```

- [ ] **Step 2: Verify failure** — `npx vitest run test/profilePins.test.ts`

- [ ] **Step 3: Implement** in `profile.ts`:

1. `factToProfileFact`: `pinned: fact.pinned,` and fix user-source detection (corrections get `capturedBy: "feature-3"` from `upsertFact`, so today they wrongly render "derived"):

```ts
function isUserSourced(fact: Fact): boolean {
  return (
    fact.provenance.capturedBy === "feature-20" ||
    fact.provenance.sourceId === "user-correction"
  );
}
```

Use `source: isUserSourced(fact) ? "user" : "derived"` everywhere the ternary on `capturedBy` appears today (preferences/communication via `factToProfileFact`, routines inline, people/projects anchors).

2. Routine facet literal: `pinned: fact.pinned,`.

3. People/projects anchor selection prefers pinned facts:

```ts
      const anchor = facts.reduce(
        (best, f) =>
          Number(f.pinned) - Number(best.pinned) ||
          f.provenance.confidence - best.provenance.confidence > 0
            ? f
            : best,
        facts[0]!,
      );
```

(Write it as an explicit comparator — pinned first, then confidence — not the hardcoded `false`.) Facet `pinned: anchor.pinned`.

4. `correctFact`'s `upsertFact` call gains `pinned: true,`.

5. New method:

```ts
  /**
   * Pin/unpin a fact (user confirmation). Persisted on the facts row so
   * consolidation's resolve/forget stages can respect it.
   */
  async setPinned(factId: string, pinned: boolean): Promise<PersonalProfile> {
    const updated = this.store.setFactPinned(factId, pinned);
    if (!updated) {
      throw new Error(`ProfileService.setPinned: fact ${factId} not found`);
    }
    return this.deriveProfile();
  }
```

6. `editFacet`: replace the cache-only mutation for pin updates:

```ts
    if (updates.pinned !== undefined) {
      return this.setPinned(factId, updates.pinned);
    }
```

(keep the remaining cache-only path for any other cosmetic updates).

- [ ] **Step 4: Run** — `npx vitest run test/profilePins.test.ts test/profile.test.ts` → PASS (existing profile.test.ts must stay green).
- [ ] **Step 5: Commit** — `feat(memory): profile pins persist + corrections born pinned (feature 20)`

---

### Task 3: Consolidation enforcement — pinned prior wins in resolveFact

**Files:**
- Modify: `services/memory/src/consolidation/contradictions.ts`
- Test: `services/memory/test/pinnedConsolidation.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
/**
 * Feature 20 — pinned facts are never silently overwritten by consolidation.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { MemoryStore } from "../src/store/memoryStore.js";
import { FakeEmbedder, FakeLlm } from "../src/testing/fakes.js";
import { resolveFact } from "../src/consolidation/contradictions.js";
import { computeForgetDecisions } from "../src/consolidation/forget.js";
import type { ExtractedFact } from "../src/types.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-pincons-test-"));
  return new MemoryStore(openDatabase(dir), new FakeEmbedder());
}

function incoming(entity: string, object: string): ExtractedFact {
  return {
    id: undefined as unknown as string,
    runId: "run-1",
    sourceRecordId: "rec-1",
    entity,
    predicate: "prefers",
    object,
    text: `User prefers ${object}`,
    confidence: 0.9,
    validFrom: new Date(Date.now() + 1000).toISOString(), // newer than prior
    validTo: null,
    sourceTrust: 0.9, // higher trust than prior — would normally win
  };
}

describe("resolveFact vs pinned prior", () => {
  it("a pinned prior survives a higher-trust newer incoming; incoming recorded historical + conflict flagged", async () => {
    const store = makeStore();
    const prior = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "dark roast",
      text: "User prefers dark roast",
      validFrom: new Date().toISOString(),
      sourceTrust: 0.5,
      pinned: true,
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.8 },
    });

    const result = await resolveFact(incoming("self", "light roast"), store, new FakeLlm());

    const priorAfter = store.getFactById(prior.id)!;
    expect(priorAfter.validTo).toBeNull();
    expect(priorAfter.invalidatedAt).toBeNull();
    expect(result.invalidatedIds).toHaveLength(0);
    expect(result.conflictFlagged).toBe(true);
    // Incoming is recorded but closed (historical), so derivation ignores it.
    const incomingFact = store.getFactById(result.factId)!;
    expect(incomingFact.validTo).not.toBeNull();
  });

  it("an unpinned prior is still superseded by a higher-trust incoming", async () => {
    const store = makeStore();
    const prior = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "dark roast",
      text: "User prefers dark roast",
      validFrom: new Date().toISOString(),
      sourceTrust: 0.5,
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.8 },
    });
    const result = await resolveFact(incoming("self", "light roast"), store, new FakeLlm());
    expect(result.invalidatedIds).toContain(prior.id);
  });
});
```

(Adjust the `ExtractedFact` literal to the real type — check `src/types.ts`; `id` may be optional.)

- [ ] **Step 2: Verify failure** — pinned-prior test fails (prior gets invalidated today).

- [ ] **Step 3: Implement** in `contradictions.ts`, inside the `livePriors.length > 0` branch, right after the `sameValue` duplicate check:

```ts
    if (prior.pinned) {
      // Feature 20: a user-confirmed fact is never superseded by consolidation.
      // Record the incoming fact as historical (closed interval) and flag the
      // conflict so the run reports it and the UI can surface it.
      const closedFact = await store.upsertFact({
        ...buildFactInput(incoming, entityId),
        validTo: incoming.validFrom,
      });
      return { invalidatedIds: [], conflictFlagged: true, factId: closedFact.id };
    }
```

(`prior` here is the live `Fact` from `livePriors[0]`, which now carries `pinned`.)

- [ ] **Step 4: Run** — `npx vitest run test/pinnedConsolidation.test.ts` + existing consolidation tests → PASS.
- [ ] **Step 5: Commit** — `feat(memory): pinned facts survive consolidation supersession (feature 20)`

---

### Task 4: Consolidation enforcement — forget/compression keep pinned facts

**Files:**
- Modify: `services/memory/src/consolidation/forget.ts`
- Test: `services/memory/test/pinnedConsolidation.test.ts` (extend)

- [ ] **Step 1: Write failing test** (append)

```ts
describe("forget stage vs pinned facts", () => {
  it("a pinned, stale, low-importance fact is kept (protected)", async () => {
    const store = makeStore();
    const fact = await store.upsertFact({
      subjectId: "self",
      predicate: "prefers",
      objectLiteral: "obscure thing",
      text: "User prefers obscure thing",
      validFrom: "2020-01-01T00:00:00.000Z",
      pinned: true,
      provenance: { source: "chat", sourceId: "msg-1", confidence: 0.3 },
    });
    // Age it: lastAccessed far in the past, importance low.
    store.rawDb.prepare(
      `UPDATE facts SET importance = 1, last_accessed_at = 0, access_count = 0 WHERE id = ?`,
    ).run(fact.id);
    // Give the entity headroom so the min-facts floor doesn't mask the pin.
    for (let i = 0; i < 3; i++) {
      await store.upsertFact({
        subjectId: "self",
        predicate: `filler_${i}`,
        objectLiteral: `filler ${i}`,
        text: `filler ${i}`,
        validFrom: new Date().toISOString(),
        provenance: { source: "chat", sourceId: `f-${i}`, confidence: 0.9 },
      });
    }

    const decisions = computeForgetDecisions(store, Date.now());
    const d = decisions.find((x) => x.factId === fact.id)!;
    expect(d.action).toBe("keep");
    expect(d.protectedByFloor).toBe(true);
    expect(d.reason).toMatch(/pinned/);
  });
});
```

- [ ] **Step 2: Verify failure** — decay score of an aged importance-1 fact lands below EVICT_THRESHOLD ⇒ currently "evict".

- [ ] **Step 3: Implement** in `forget.ts`:
- Add `pinned` to the SELECT in `computeForgetDecisions` and to the row type (`pinned: number`).
- Extend the protection branch:

```ts
    const protectedByFloor =
      f.pinned === 1 ||
      f.importance >= IMPORTANCE_FLOOR ||
      entityFactCount <= MIN_FACTS_PER_ENTITY;
    ...
    if (protectedByFloor) {
      action = "keep";
      reason = f.pinned === 1
        ? "pinned by user"
        : f.importance >= IMPORTANCE_FLOOR
          ? `importance ${f.importance} >= floor ${IMPORTANCE_FLOOR}`
          : `entity below min facts floor (${entityFactCount}/${MIN_FACTS_PER_ENTITY})`;
    }
```

(Compression operates on `action === "compress"` decisions only, so pinned facts — now always `keep` — can never enter a compression group. No change needed there beyond this.)

- [ ] **Step 4: Run** — `npx vitest run test/pinnedConsolidation.test.ts test/` (full memory suite) → PASS.
- [ ] **Step 5: Commit** — `feat(memory): forget stage never evicts/compresses pinned facts (feature 20)`

---

### Task 5: Conflict detection in deriveProfile (`conflictsWith`)

**Files:**
- Modify: `services/memory/src/profile/types.ts` (`ProfileFact`)
- Modify: `services/memory/src/profile/profile.ts`
- Test: `services/memory/test/profile.test.ts` (extend)

- [ ] **Step 1: Write failing test** (append to `profile.test.ts`)

```ts
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

  it("same-value duplicates and 'summary' facts are not flagged", async () => {
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
});
```

- [ ] **Step 2: Verify failure**.

- [ ] **Step 3: Implement**

`profile/types.ts` — `ProfileFact` gains:

```ts
  /** Live fact ids holding a different value for the same subject+predicate. */
  conflictsWith?: string[];
```

`profile.ts` — at the top of `deriveProfile` after `getAllLiveFacts`:

```ts
    // Conflict detection (deterministic): >1 live fact on the same
    // (subject, predicate) with differing values ⇒ cross-flag them all.
    // "summary" facts (forget-stage compression output) are exempt.
    const conflictsById = new Map<string, string[]>();
    {
      const groups = new Map<string, Fact[]>();
      for (const f of liveFacts) {
        if (f.predicate === "summary") continue;
        const key = `${f.subjectId} ${f.predicate}`;
        const g = groups.get(key) ?? [];
        g.push(f);
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        const values = new Set(
          g.map((f) => (f.objectLiteral ?? f.objectId ?? f.text).toLowerCase().trim()),
        );
        if (values.size < 2) continue;
        for (const f of g) {
          conflictsById.set(f.id, g.filter((o) => o.id !== f.id).map((o) => o.id));
        }
      }
    }
```

`factToProfileFact` gains a `conflictsWith?: string[]` param spread into the result (only set when non-empty); the routines/people/projects facet builders pass `conflictsById.get(fact.id)` / `conflictsById.get(anchor.id)` similarly:

```ts
function factToProfileFact(fact: Fact, description?: string, conflictsWith?: string[]): ProfileFact {
  return {
    ...,
    ...(conflictsWith && conflictsWith.length > 0 ? { conflictsWith } : {}),
  };
}
```

- [ ] **Step 4: Run** — full memory profile tests → PASS.
- [ ] **Step 5: Commit** — `feat(memory): surface contradictory profile facets via conflictsWith (feature 20)`

---

### Task 6: `inject.ts` — salient facet selection + `getProfileContext`

**Files:**
- Create: `services/memory/src/profile/inject.ts`
- Modify: `services/memory/src/profile/profile.ts` (`deriveProfile` deterministic mode, `getProfileContext`)
- Modify: `services/memory/src/index.ts` (export `buildProfileContext`, `ProfileContextOptions`)
- Test: `services/memory/test/inject.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
/**
 * Feature 20 — deterministic top-N salient facet selection for prompt injection.
 */
import { describe, it, expect } from "vitest";
import { buildProfileContext } from "../src/profile/inject.js";
import type { PersonalProfile, ProfileFact } from "../src/profile/types.js";

const NOW = new Date("2026-06-11T12:00:00.000Z");

function fact(over: Partial<ProfileFact> & { value: string }): ProfileFact {
  return {
    id: over.id ?? `f-${over.value}`,
    value: over.value,
    confidence: over.confidence ?? 0.8,
    pinned: over.pinned ?? false,
    source: over.source ?? "derived",
    updatedAt: over.updatedAt ?? "2026-06-01T00:00:00.000Z",
    ...(over.conflictsWith ? { conflictsWith: over.conflictsWith } : {}),
  };
}

function profileWith(over: Partial<PersonalProfile>): PersonalProfile {
  return {
    preferences: [], people: [], projects: [], routines: [],
    communicationStyle: [], proceduralBlock: "", version: 1,
    updatedAt: NOW.toISOString(), ...over,
  };
}

describe("buildProfileContext", () => {
  it("returns '' for an empty profile", () => {
    expect(buildProfileContext(profileWith({}), "coffee", { now: NOW })).toBe("");
  });

  it("ranks query-relevant facets first and caps at maxFacets", () => {
    const p = profileWith({
      preferences: [
        fact({ value: "dark roast coffee" }),
        fact({ value: "TypeScript strict mode" }),
        fact({ value: "window seats" }),
      ],
    });
    const out = buildProfileContext(p, "what coffee should I order?", { maxFacets: 1, now: NOW });
    expect(out).toContain("dark roast coffee");
    expect(out).not.toContain("TypeScript");
    expect(out.startsWith("## About the user")).toBe(true);
  });

  it("falls back to at most 3 pinned/high-confidence facets when nothing is relevant", () => {
    const p = profileWith({
      preferences: [
        fact({ value: "alpha", confidence: 0.4 }),
        fact({ value: "beta", confidence: 0.9 }),
        fact({ value: "gamma", confidence: 0.5, pinned: true }),
        fact({ value: "delta", confidence: 0.6 }),
      ],
    });
    const out = buildProfileContext(p, "zzz qqq", { now: NOW });
    const bullets = out.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeLessThanOrEqual(3);
    expect(out).toContain("gamma"); // pinned wins the fallback floor
  });

  it("only the conflict winner is injected (recency beats confidence; pin beats both)", () => {
    const p = profileWith({
      preferences: [
        fact({ id: "old", value: "vim editor", confidence: 0.9,
               updatedAt: "2026-01-01T00:00:00.000Z", conflictsWith: ["new"] }),
        fact({ id: "new", value: "emacs editor", confidence: 0.6,
               updatedAt: "2026-05-01T00:00:00.000Z", conflictsWith: ["old"] }),
      ],
    });
    const out = buildProfileContext(p, "which editor do I like?", { now: NOW });
    expect(out).toContain("emacs");
    expect(out).not.toContain("vim");

    const pinnedOld = profileWith({
      preferences: [
        fact({ id: "old", value: "vim editor", confidence: 0.9, pinned: true,
               updatedAt: "2026-01-01T00:00:00.000Z", conflictsWith: ["new"] }),
        fact({ id: "new", value: "emacs editor", confidence: 0.6,
               updatedAt: "2026-05-01T00:00:00.000Z", conflictsWith: ["old"] }),
      ],
    });
    const out2 = buildProfileContext(pinnedOld, "which editor do I like?", { now: NOW });
    expect(out2).toContain("vim");
    expect(out2).not.toContain("emacs");
  });

  it("respects maxChars", () => {
    const p = profileWith({
      preferences: Array.from({ length: 10 }, (_, i) =>
        fact({ id: `f${i}`, value: `coffee preference number ${i} with a long tail` })),
    });
    const out = buildProfileContext(p, "coffee", { maxChars: 120, now: NOW });
    expect(out.length).toBeLessThanOrEqual(140); // header + capped bullets
  });

  it("renders people/projects/routines with names", () => {
    const p = profileWith({
      people: [{ ...fact({ value: "x" }), id: "p1",
        value: { name: "Maya", relationship: "manager", notes: "weekly 1:1s" } } as never],
      projects: [{ ...fact({ value: "x" }), id: "pr1",
        value: { name: "Jarvis", status: "active", description: "second brain" } } as never],
      routines: [{ ...fact({ value: "x" }), id: "r1",
        value: { description: "gym", cadence: "Tue/Thu" } } as never],
    });
    const out = buildProfileContext(p, "when do I see Maya at the gym for Jarvis?", { now: NOW });
    expect(out).toContain("Maya");
    expect(out).toContain("Jarvis");
    expect(out).toContain("gym");
  });
});
```

- [ ] **Step 2: Verify failure** (module not found).

- [ ] **Step 3: Implement `inject.ts`** (complete file):

```ts
/**
 * Profile context injection (feature 20 — the spec's inject.ts).
 *
 * Selects the top-N salient facets relevant to a query and renders a compact
 * "## About the user" markdown block for the chat/agent system prompt.
 *
 * Fully deterministic — token-overlap relevance × confidence × recency with a
 * pinned boost. NO LLM: this runs inline on the chat path where AI is banned.
 * Over-personalization guard: relevance-first selection; when nothing matches
 * the query, a small fallback floor (≤3 facets) keeps minimal personalization
 * without locking the model into the whole profile.
 *
 * NOTE(scale): swap token overlap for embedding similarity here if facet
 * counts ever make overlap too coarse — the scoring seam is this file only.
 */
import type { PersonalProfile, ProfileFact, Person, Project, Routine } from "./types.js";

export interface ProfileContextOptions {
  maxFacets?: number; // default 5
  maxChars?: number;  // default 600 (block total, header included)
  now?: Date;         // injectable for tests
}

interface Candidate {
  id: string;
  label: string;
  confidence: number;
  pinned: boolean;
  updatedAt: string;
  conflictsWith: string[];
}

const RECENCY_HALF_LIFE_DAYS = 90;
const PINNED_BOOST = 0.25;
const FALLBACK_FLOOR = 3;
const NOTE_MAX_CHARS = 120;

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

function relevance(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let hits = 0;
  for (const t of queryTokens) if (textTokens.has(t)) hits++;
  return hits / queryTokens.size;
}

function recencyFactor(updatedAt: string, nowMs: number): number {
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return 0.5;
  const ageDays = Math.max(0, (nowMs - parsed) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function candidate(f: ProfileFact<unknown>, label: string): Candidate {
  return {
    id: f.id,
    label,
    confidence: f.confidence,
    pinned: f.pinned,
    updatedAt: f.updatedAt,
    conflictsWith: f.conflictsWith ?? [],
  };
}

function collectCandidates(p: PersonalProfile): Candidate[] {
  const out: Candidate[] = [];
  for (const f of p.preferences) out.push(candidate(f, `Preference: ${f.value}`));
  for (const f of p.people) {
    const v = f.value as Person;
    const rel = v.relationship ? ` (${v.relationship})` : "";
    const notes = v.notes ? ` — ${truncate(v.notes, NOTE_MAX_CHARS)}` : "";
    out.push(candidate(f, `${v.name}${rel}${notes}`));
  }
  for (const f of p.projects) {
    const v = f.value as Project;
    const desc = v.description ? ` — ${truncate(v.description, NOTE_MAX_CHARS)}` : "";
    out.push(candidate(f, `Project ${v.name} [${v.status}]${desc}`));
  }
  for (const f of p.routines) {
    const v = f.value as Routine;
    const cadence = v.cadence ? ` (${v.cadence})` : "";
    out.push(candidate(f, `Routine: ${v.description}${cadence}`));
  }
  for (const f of p.communicationStyle) {
    out.push(candidate(f, `Communication style: ${f.value}`));
  }
  return out;
}

/** Winner of a conflict pair: pinned > newer > higher confidence. */
function conflictWinner(a: Candidate, b: Candidate): Candidate {
  if (a.pinned !== b.pinned) return a.pinned ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.confidence >= b.confidence ? a : b;
}

function dropConflictLosers(cands: Candidate[]): Candidate[] {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const losers = new Set<string>();
  for (const c of cands) {
    if (losers.has(c.id)) continue;
    for (const otherId of c.conflictsWith) {
      const other = byId.get(otherId);
      if (!other || losers.has(other.id)) continue;
      losers.add(conflictWinner(c, other) === c ? other.id : c.id);
      if (losers.has(c.id)) break;
    }
  }
  return cands.filter((c) => !losers.has(c.id));
}

/**
 * Render the profile-context block for a query. Returns "" when the profile
 * has nothing to offer (cold start) — callers omit the block entirely.
 */
export function buildProfileContext(
  profile: PersonalProfile,
  query: string,
  opts: ProfileContextOptions = {},
): string {
  const { maxFacets = 5, maxChars = 600 } = opts;
  const nowMs = (opts.now ?? new Date()).getTime();
  const queryTokens = tokenize(query);

  const candidates = dropConflictLosers(collectCandidates(profile));
  if (candidates.length === 0) return "";

  const scored = candidates.map((c) => {
    const rel = relevance(queryTokens, c.label);
    const base = (0.5 + 0.5 * c.confidence) * recencyFactor(c.updatedAt, nowMs);
    return { c, rel, score: rel * base + (c.pinned ? PINNED_BOOST * rel : 0) };
  });

  let picked = scored
    .filter((s) => s.rel > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, maxFacets);

  if (picked.length === 0) {
    picked = [...scored]
      .sort(
        (x, y) =>
          Number(y.c.pinned) - Number(x.c.pinned) ||
          y.c.confidence - x.c.confidence ||
          y.c.updatedAt.localeCompare(x.c.updatedAt),
      )
      .slice(0, Math.min(FALLBACK_FLOOR, maxFacets));
  }

  const header = "## About the user";
  const lines: string[] = [];
  let used = header.length;
  for (const { c } of picked) {
    const line = `- ${c.label}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return `${header}\n${lines.join("\n")}`;
}
```

**`profile.ts`** — deterministic derive mode + context accessor:

```ts
  async deriveProfile(opts: { useLlm?: boolean } = {}): Promise<PersonalProfile> {
    const useLlm = opts.useLlm !== false;
```

…and the person-summary branch becomes `if (useLlm && this.llm && facts.length > 0) {`.

```ts
  /**
   * Query-relevant profile block for prompt injection (feature 2/5 consumers).
   * Deterministic end-to-end: derivation skips LLM person summaries (fallback
   * join) because this runs inline on the chat path.
   */
  async getProfileContext(query: string, opts?: ProfileContextOptions): Promise<string> {
    const profile = await this.deriveProfile({ useLlm: false });
    return buildProfileContext(profile, query, opts);
  }
```

(import `buildProfileContext`, `ProfileContextOptions` from `./inject.js`).

**`index.ts`** — add exports:

```ts
export { buildProfileContext } from "./profile/inject.js";
export type { ProfileContextOptions } from "./profile/inject.js";
```

- [ ] **Step 4: Run** — `npx vitest run` (full memory suite) → PASS.
- [ ] **Step 5: Commit** — `feat(memory): deterministic salient-facet injection (inject.ts, feature 20)`

---

### Task 7: Chat wiring — profile block in the system prompt

**Files:**
- Modify: `services/core/src/chat/contextBudget.ts` (`PROFILE_CAP`, `capProfile`)
- Modify: `services/core/src/chat/promptAssembler.ts` (`profileContext` arg + budget)
- Modify: `services/core/src/chat/types.ts` (budget gains `profile: number` — check the `AssembledPrompt` budget shape and extend)
- Modify: `services/core/src/chat/chatCore.ts` (load + pass)
- Test: extend the existing core prompt-assembler/chat test files (locate via `ls services/core/test/`; follow their patterns)

- [ ] **Step 1: Write failing tests** (in the existing prompt assembler test file, matching its style)

```ts
describe("profile context block", () => {
  it("renders the profile block under the procedural block in the system message", () => {
    const out = assemblePrompt({
      procedural: "Be concise.",
      profileContext: "## About the user\n- Preference: dark roast coffee",
      memories: [],
      history: [],
      userMessage: "hi",
      contextWindow: 16_000,
      mode: "local",
      now: new Date("2026-06-11T12:00:00.000Z"),
    });
    const system = out.messages[0]!.content;
    expect(system).toContain("## About the user");
    expect(system.indexOf("## How I work")).toBeLessThan(system.indexOf("## About the user"));
    expect(out.budget.profile).toBeGreaterThan(0);
  });

  it("omits the block when empty and reports zero budget", () => {
    const out = assemblePrompt({
      procedural: "",
      memories: [],
      history: [],
      userMessage: "hi",
      contextWindow: 16_000,
      mode: "local",
      now: new Date("2026-06-11T12:00:00.000Z"),
    });
    expect(out.messages[0]!.content).not.toContain("About the user");
    expect(out.budget.profile).toBe(0);
  });
});
```

Plus a `capProfile` unit test in the contextBudget test file:

```ts
it("capProfile truncates past PROFILE_CAP tokens", () => {
  expect(capProfile("")).toBe("");
  const long = "x".repeat(PROFILE_CAP * 4 + 100);
  expect(capProfile(long).length).toBe(PROFILE_CAP * 4);
});
```

And a ChatCore test (in the existing chatCore test file, using its fake MemorySystem fixture): a fake `profile.getProfileContext` returning `"## About the user\n- Preference: tea"` must show up in the gateway-captured system message; a throwing `getProfileContext` must degrade to no block, not fail the turn.

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement**

`contextBudget.ts`:

```ts
export const PROFILE_CAP = 300;

/** Cap the profile-context block to its hard budget (PROFILE_CAP tokens). */
export function capProfile(profile: string): string {
  if (!profile) return "";
  if (countTokens(profile) <= PROFILE_CAP) return profile;
  return profile.slice(0, PROFILE_CAP * 4);
}
```

`promptAssembler.ts`:
- `AssembleArgs` gains `profileContext?: string; // feature 20: query-relevant "## About the user" block ("" = omit)`.
- After `const procedural = capProcedural(a.procedural);` add `const profile = capProfile(a.profileContext ?? "");`.
- `systemBlock` array gains, after the procedural entry: `profile, // block already carries its "## About the user" header`.
- Budget: `profile: countTokens(profile),` added to the returned budget (and to the budget type in `types.ts`).

`chatCore.ts`:

```ts
/**
 * Query-relevant profile facets (feature 20). Returns "" on failure — chat
 * must never hard-fail because the profile is unavailable.
 */
async function loadProfileContext(
  memory: MemorySystem | null,
  query: string,
): Promise<string> {
  if (!memory) return "";
  try {
    return await memory.profile.getProfileContext(query);
  } catch (err) {
    console.warn("[memory] getProfileContext failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}
```

In `send()` after the `procedural` load: `const profileContext = await loadProfileContext(this.memory, args.message);`
`systemTokens` estimate adds `countTokens(profileContext) +`. `assemblePrompt({ ... })` gains `profileContext,`.

- [ ] **Step 4: Build memory first, then run core tests**

```bash
npm run build --workspace @jarvis/memory
npm test --workspace @jarvis/core
```

→ PASS.

- [ ] **Step 5: Commit** — `feat(core): inject query-relevant profile facets into the chat prompt (feature 20)`

---

### Task 8: Agent user-context provider

**Files:**
- Modify: `services/agent/src/types.ts` (add `UserContextProvider`)
- Modify: `services/agent/src/core/agent.ts` (option + resolve once per run)
- Modify: `services/agent/src/core/reactLoop.ts` (`ReactLoopOptions.userContext`)
- Modify: `services/agent/src/core/harness.ts` (`validateAndRetry` + `buildToolCallPrompt`)
- Modify: `services/agent/src/proactive/scheduler.ts` (`SchedulerOptions.userContext` → its internal `AgentRunner`)
- Modify: `services/agent/src/index.ts` (config plumb + export type)
- Modify: `services/core/src/agent/agentSystem.ts` + its call site in `services/core/src/server.ts` (wire memory profile)
- Test: agent harness/runner test files (locate via `ls services/agent/test/`; follow existing FakeLlm patterns)

- [ ] **Step 1: Write failing tests** (agent package, matching existing fixtures)

```ts
describe("user context injection", () => {
  it("buildToolCallPrompt includes the user context section when provided", () => {
    const prompt = buildToolCallPrompt("book lunch", [], [], "- Preference: vegetarian");
    expect(prompt).toContain("User context:");
    expect(prompt).toContain("vegetarian");
  });

  it("buildToolCallPrompt omits the section when absent", () => {
    expect(buildToolCallPrompt("book lunch", [], [])).not.toContain("User context:");
  });

  it("AgentRunner resolves the provider once and a throwing provider degrades to no context", async () => {
    // FakeLlm scripted to emit __done__; provider returns a recognizable string.
    // Assert via the FakeLlm's captured prompts that the context string appears.
    // Second runner with a throwing provider: run still completes (status done).
  });
});
```

(Write the AgentRunner test concretely against the package's existing FakeLlm fixture — it records prompts; assert `prompts.some(p => p.includes("vegetarian"))`, and for the throwing provider assert the run finishes with no `User context:` in any prompt.)

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement**

`types.ts`:

```ts
/**
 * Optional per-run user context (feature 20): given the run's goal, return a
 * short profile/preference block to ground the agent's planning and tool
 * selection. Injected by core (memory profile); leaf package never imports it.
 */
export type UserContextProvider = (goal: string) => string | Promise<string>;
```

`agent.ts`:
- `AgentRunnerOptions` gains `userContext?: UserContextProvider;`
- Top of `run()`:

```ts
    const userContext = await resolveUserContext(this.opts.userContext, goal);
```

- module-level helper:

```ts
const USER_CONTEXT_MAX_CHARS = 1_200;

/** Resolve the user-context provider; failures and oversize degrade silently. */
async function resolveUserContext(
  provider: UserContextProvider | undefined,
  goal: string,
): Promise<string> {
  if (!provider) return "";
  try {
    const raw = await provider(goal);
    return raw.length > USER_CONTEXT_MAX_CHARS
      ? raw.slice(0, USER_CONTEXT_MAX_CHARS)
      : raw;
  } catch {
    return "";
  }
}
```

- Plan step: `state.plan = await producePlan(llm, goal, userContext ? [userContext] : []);` (reuses `producePlan`'s existing "Relevant context" rendering).
- ReAct call gains `userContext,` in its options object.

`reactLoop.ts`: `ReactLoopOptions` gains `userContext?: string;`; destructure it and pass to the harness: `validateAndRetry({ llm, goal: stepDescription, scratchpad: state.scratchpad, tools, userContext })`.

`harness.ts`: `validateAndRetry` opts gain `userContext?: string;`, threaded to the prompt builder. `buildToolCallPrompt(goal, scratchpad, tools, userContext?)`:

```ts
  const context = userContext
    ? `\nUser context:\n${userContext}\n`
    : "";

  return (
    `You are a reasoning agent. Your goal: ${goal}` +
    context +
    scratch +
    ...
```

`scheduler.ts`: `SchedulerOptions` gains `userContext?: UserContextProvider;`; its internal `new AgentRunner({...})` passes it through.

`index.ts`: `AgentSystemConfig` gains `userContext?: UserContextProvider;`; `createAgentSystem` passes it to both `AgentRunner` and `Scheduler`; export the type.

`services/core/src/agent/agentSystem.ts`: `getAgentSystem(gateway, integrations, memory?: MemorySystem | null)` — new optional param; in `createAgentSystem({ ... })` add:

```ts
      userContext: memory
        ? (goal: string) => memory.profile.getProfileContext(goal)
        : undefined,
```

(import the `MemorySystem` type from `@jarvis/memory`). Update the `server.ts` call site to pass the memory system it already holds (`getMemorySystem(gateway)` result) — check the exact call site with `grep -n "getAgentSystem" services/core/src/server.ts` and pass the same memory instance the chat path uses.

- [ ] **Step 4: Run**

```bash
npm test --workspace @jarvis/agent
npm run build --workspace @jarvis/agent && npm run build --workspace @jarvis/memory
npm test --workspace @jarvis/core
```

→ PASS.

- [ ] **Step 5: Commit** — `feat(agent,core): ground agent runs in user profile context (feature 20)`

---

### Task 9: Dashboard — pin/confirm + conflict surfacing

**Files:**
- Modify: `apps/dashboard/app/lib/contracts.ts` (`ProfileFactContract.conflictsWith`)
- Modify: `apps/dashboard/app/api/profile/route.ts` (map `conflictsWith`; PATCH `pinned` variant)
- Modify: `apps/dashboard/app/components/ProfileView.tsx` (Confirm/Unpin button, conflict badge, `handlePin`)
- Modify: `apps/dashboard/app/globals.css` (`.badge-conflict` style next to `.badge-pinned` — match the existing electric-blue HUD theme; conflicts use the theme's warning/danger accent)

- [ ] **Step 1: contracts.ts** — `ProfileFactContract` gains:

```ts
  /** Ids of live facts holding a contradictory value (user resolves in UI). */
  conflictsWith?: string[];
```

- [ ] **Step 2: route.ts**
- Every facet mapper in `toContract` adds `conflictsWith: f.conflictsWith,`.
- PATCH handler:

```ts
    const body = (await req.json()) as {
      factId?: string;
      correction?: string;
      pinned?: boolean;
    };
    const { factId, correction, pinned } = body;

    if (!factId || (typeof correction !== "string" && typeof pinned !== "boolean")) {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "factId plus correction or pinned is required" } },
        { status: 400 },
      );
    }

    const mem = getMemory();
    const profile =
      typeof pinned === "boolean"
        ? await mem.profile.setPinned(factId, pinned)
        : await mem.profile.correctFact({ factId, correction: correction! });
```

- [ ] **Step 3: ProfileView.tsx**
- `handlePin(factId: string, pinned: boolean)` mirroring `handleCorrect` with body `JSON.stringify({ factId, pinned })`.
- `FactCardProps` gains `onPin: (factId: string, pinned: boolean) => void;`; the actions row gains, before "This is wrong":

```tsx
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => onPin(fact.id, !fact.pinned)}
            title={fact.pinned ? "Unpin — allow consolidation to update this" : "Confirm — never auto-overwritten"}
          >
            {fact.pinned ? "Unpin" : "Confirm"}
          </button>
```

- Badges row gains `{fact.conflictsWith && fact.conflictsWith.length > 0 && (<span className="badge-conflict" title="Conflicts with another learned fact — correct or forget the wrong one">conflict</span>)}`.
- Every `<FactCard …>` call site passes `onPin={handlePin}`.

- [ ] **Step 4: globals.css** — add `.badge-conflict` beside the existing `.badge-pinned` rule, using the theme's existing error/warning color variable (inspect the file; do not invent new palette values).

- [ ] **Step 5: Typecheck + build**

```bash
cd apps/dashboard && npx tsc --noEmit -p tsconfig.json
```

→ clean. (Run `npm run build --workspace @jarvis/memory` first so `@jarvis/memory` types include `setPinned`/`conflictsWith`.)

- [ ] **Step 6: Commit** — `feat(dashboard): pin/confirm + conflict badges on profile facts (feature 20)`

---

### Task 10: Close pre-existing test gaps — `forgetEntity`, `editFacet` cache path

**Files:**
- Test: `services/memory/test/profile.test.ts` (extend)

- [ ] **Step 1: Add tests**

```ts
describe("ProfileService - forgetEntity", () => {
  it("invalidates all live facts for the named entity (case-insensitive) and drops the facet", async () => {
    const { store } = makeStore();
    const person = await seedPersonEntity(store, "Maya");
    await store.upsertFact({
      subjectId: person.id, predicate: "relationship_is", objectLiteral: "manager",
      text: "Maya is the user's manager", validFrom: new Date().toISOString(),
      provenance: { source: "chat", sourceId: "m1", confidence: 0.8 },
    });
    const svc = new ProfileService(store);
    expect((await svc.deriveProfile()).people).toHaveLength(1);

    const after = await svc.forgetEntity({ entityName: "maya" });
    expect(after.people).toHaveLength(0);
    // Bi-temporal: facts are closed out, not deleted.
    const history = store.getFactHistory(person.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.validTo).not.toBeNull();
  });

  it("is a no-op for an unknown entity", async () => {
    const { store } = makeStore();
    await seedPreferenceFact(store, "dark roast");
    const after = await new ProfileService(store).forgetEntity({ entityName: "nobody" });
    expect(after.preferences).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run** — these should pass against existing code; if one fails, that's a real bug — fix `forgetEntity` (not the test) and note it.
- [ ] **Step 3: Commit** — `test(memory): cover forgetEntity (feature 20 gap)`

---

### Task 11: Full verification + docs sync

- [ ] **Step 1: Run every affected package**

```bash
npm test --workspace @jarvis/memory
npm test --workspace @jarvis/agent
npm test --workspace @jarvis/core
npm test --workspace @jarvis/integrations   # untouched, sanity
cd apps/dashboard && npx tsc --noEmit -p tsconfig.json && cd ../..
```

All green, no skips.

- [ ] **Step 2: Docs** — update `CLAUDE.md` architecture section (one sentence: profile facets now injected into chat + agent; pins enforced in consolidation) and `features/20-personal-profile-and-preference-learning.md` is the spec — leave as-is (it already describes this behavior).

- [ ] **Step 3: Final commit** — `docs: feature 20 wiring notes`

---

## Self-review (done at planning time)

- **Spec coverage:** pins (Tasks 1–4), injection (6–7), agent (8), conflicts (5, 9), UI (9), test gaps (10) — all spec sections mapped.
- **Type consistency:** `setFactPinned` (store) / `setPinned` (service) / `getProfileContext(query, opts?)` / `buildProfileContext(profile, query, opts?)` / `UserContextProvider = (goal) => string | Promise<string>` used consistently across tasks.
- **Known flex points:** exact existing test-file names in core/agent (locate at execution time, follow their fixtures); `ExtractedFact` literal shape in Task 3; anchor-comparator exact expression in Task 2 (write a clear pinned-then-confidence comparator).
