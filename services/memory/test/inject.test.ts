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
    preferences: [],
    people: [],
    projects: [],
    routines: [],
    communicationStyle: [],
    proceduralBlock: "",
    version: 1,
    updatedAt: NOW.toISOString(),
    ...over,
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
        fact({
          id: "old", value: "vim editor", confidence: 0.9,
          updatedAt: "2026-01-01T00:00:00.000Z", conflictsWith: ["new"],
        }),
        fact({
          id: "new", value: "emacs editor", confidence: 0.6,
          updatedAt: "2026-05-01T00:00:00.000Z", conflictsWith: ["old"],
        }),
      ],
    });
    const out = buildProfileContext(p, "which editor do I like?", { now: NOW });
    expect(out).toContain("emacs");
    expect(out).not.toContain("vim");

    const pinnedOld = profileWith({
      preferences: [
        fact({
          id: "old", value: "vim editor", confidence: 0.9, pinned: true,
          updatedAt: "2026-01-01T00:00:00.000Z", conflictsWith: ["new"],
        }),
        fact({
          id: "new", value: "emacs editor", confidence: 0.6,
          updatedAt: "2026-05-01T00:00:00.000Z", conflictsWith: ["old"],
        }),
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
      people: [
        {
          ...fact({ value: "x" }),
          id: "p1",
          value: { name: "Maya", relationship: "manager", notes: "weekly 1:1s" },
        } as never,
      ],
      projects: [
        {
          ...fact({ value: "x" }),
          id: "pr1",
          value: { name: "Jarvis", status: "active", description: "second brain" },
        } as never,
      ],
      routines: [
        {
          ...fact({ value: "x" }),
          id: "r1",
          value: { description: "gym", cadence: "Tue/Thu" },
        } as never,
      ],
    });
    const out = buildProfileContext(p, "when do I see Maya at the gym for Jarvis?", { now: NOW });
    expect(out).toContain("Maya");
    expect(out).toContain("Jarvis");
    expect(out).toContain("gym");
  });
});
