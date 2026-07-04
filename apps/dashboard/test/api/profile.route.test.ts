import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behavioral coverage of the dashboard BFF's profile route handlers
 * (apps/dashboard/app/api/profile/route.ts) — the highest-risk untested
 * write path in the repo (TEST-01): correctFact/setPinned/forgetFact/
 * forgetEntity perform bi-temporal mutations against the same SQLite files
 * core writes.
 *
 * Isolation: each test points JARVIS_DATA_DIR at a fresh mkdtempSync() dir
 * and calls vi.resetModules() so app/lib/services.ts's module-level
 * getMemory() singleton rebuilds against that dir instead of caching a
 * previous test's (or the real ~/.jarvis/data) instance. Handlers are
 * imported dynamically INSIDE each test, after the reset, so the import
 * picks up the fresh module graph.
 *
 * The dashboard's noOpEmbedder returns [] (embedding: null on every seeded
 * fact), so assertions go through deriveProfile()/the envelope contract —
 * never through semantic retrieve().
 */

async function freshHandlers() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-dashboard-test-"));
  process.env.JARVIS_DATA_DIR = dir;
  vi.resetModules();
  const services = await import("../../app/lib/services");
  const route = await import("../../app/api/profile/route");
  return { dir, services, route };
}

/** Seed a "self" entity + a `prefers` fact so it lands in the preferences facet. */
async function seedPreferenceFact(store: import("@jarvis/memory").MemoryStore, value: string) {
  const entity = await store.upsertEntity({
    name: "self",
    entityType: "other",
    text: "the user",
    provenance: { source: "system", sourceId: "test-seed", confidence: 1.0 },
  });
  const fact = await store.upsertFact({
    subjectId: entity.id,
    predicate: "prefers",
    objectLiteral: value,
    text: `prefers: ${value}`,
    validFrom: new Date().toISOString(),
    provenance: { source: "system", sourceId: "test-seed", confidence: 1.0 },
  });
  return { entityId: entity.id, entityName: entity.name, factId: fact.id };
}

beforeEach(() => {
  delete process.env.JARVIS_DATA_DIR;
});

// ── Wave-0 spike (Open Question 1): does direct NextRequest handler
// invocation work under plain vitest with the server-only alias? ───────────

describe("profile route — spike", () => {
  it("GET on an empty temp dir returns state: empty and status 200", async () => {
    const { route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/profile");
    const res = await route.GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("empty");
  });

  it("PATCH with a missing factId returns 400 BAD_REQUEST", async () => {
    const { route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ correction: "new value" }),
    });
    const res = await route.PATCH(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});

// ── Full behavioral coverage ─────────────────────────────────────────────

describe("profile route — PATCH correctFact", () => {
  it("invalidates the old fact and the corrected value is live afterward", async () => {
    const { services, route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const mem = services.getMemory();
    const { factId } = await seedPreferenceFact(mem.store, "tea");

    const req = new NextRequest("http://localhost/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ factId, correction: "coffee" }),
    });
    const res = await route.PATCH(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ok");

    const profile = await mem.profile.deriveProfile();
    const values = profile.preferences.map((f) => f.value);
    expect(values).toContain("coffee");
    expect(values).not.toContain("tea");
  });
});

describe("profile route — PATCH setPinned", () => {
  it("pins and unpins a fact, round-tripping the pinned flag", async () => {
    const { services, route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const mem = services.getMemory();
    const { factId } = await seedPreferenceFact(mem.store, "tea");

    const pinReq = new NextRequest("http://localhost/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ factId, pinned: true }),
    });
    const pinRes = await route.PATCH(pinReq);
    expect(pinRes.status).toBe(200);
    const pinBody = await pinRes.json();
    const pinnedFact = pinBody.data.preferences.find((f: { id: string }) => f.id === factId);
    expect(pinnedFact?.pinned).toBe(true);

    const unpinReq = new NextRequest("http://localhost/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ factId, pinned: false }),
    });
    const unpinRes = await route.PATCH(unpinReq);
    expect(unpinRes.status).toBe(200);
    const unpinBody = await unpinRes.json();
    const unpinnedFact = unpinBody.data.preferences.find((f: { id: string }) => f.id === factId);
    expect(unpinnedFact?.pinned).toBe(false);
  });
});

describe("profile route — PATCH both-fields guard", () => {
  it("rejects correction and pinned together with 400", async () => {
    const { services, route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const mem = services.getMemory();
    const { factId } = await seedPreferenceFact(mem.store, "tea");

    const req = new NextRequest("http://localhost/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ factId, correction: "x", pinned: true }),
    });
    const res = await route.PATCH(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("send either correction or pinned, not both");
  });
});

describe("profile route — DELETE forgetFact", () => {
  it("invalidates the fact; it is no longer live in a fresh deriveProfile()", async () => {
    const { services, route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const mem = services.getMemory();
    const { factId } = await seedPreferenceFact(mem.store, "tea");

    const req = new NextRequest("http://localhost/api/profile", {
      method: "DELETE",
      body: JSON.stringify({ factId }),
    });
    const res = await route.DELETE(req);
    expect(res.status).toBe(200);

    const profile = await mem.profile.deriveProfile();
    const values = profile.preferences.map((f) => f.value);
    expect(values).not.toContain("tea");
  });
});

describe("profile route — DELETE forgetEntity", () => {
  it("invalidates all of the entity's facts", async () => {
    const { services, route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const mem = services.getMemory();
    const { entityName } = await seedPreferenceFact(mem.store, "tea");

    const req = new NextRequest("http://localhost/api/profile", {
      method: "DELETE",
      body: JSON.stringify({ entityName }),
    });
    const res = await route.DELETE(req);
    expect(res.status).toBe(200);

    const profile = await mem.profile.deriveProfile();
    const values = profile.preferences.map((f) => f.value);
    expect(values).not.toContain("tea");
  });
});

describe("profile route — DELETE XOR guard", () => {
  it("rejects neither entityName nor factId with 400", async () => {
    const { route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/profile", {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    const res = await route.DELETE(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("send exactly one of entityName or factId");
  });

  it("rejects both entityName and factId with 400", async () => {
    const { route } = await freshHandlers();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/profile", {
      method: "DELETE",
      body: JSON.stringify({ entityName: "self", factId: "some-id" }),
    });
    const res = await route.DELETE(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("send exactly one of entityName or factId");
  });
});
