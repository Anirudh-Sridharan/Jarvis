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
