/**
 * GET  /api/profile       — derive + return the PersonalProfile
 * PATCH /api/profile      — correctFact: { factId, correction } → re-derive profile
 *                           or pin:     { factId, pinned } → setPinned
 * DELETE /api/profile     — forgetEntity: { entityName } → invalidate all its facts
 *
 * Uses the ProfileService via the memory system (read-instance pattern from services.ts).
 * Degrades gracefully: returns empty profile when no data exists.
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, ProfileContract, ProfileFactContract } from "@/app/lib/contracts";
import { getMemory } from "@/app/lib/services";
import type { PersonalProfile, ProfileFact } from "@jarvis/memory";

// ── Shape mapper ──────────────────────────────────────────────────────────────

/**
 * Common ProfileFact → ProfileFactContract envelope. Every facet shares this
 * metadata (id/confidence/pinned/source/provenance/updatedAt/conflictsWith);
 * only the `value` payload differs, so callers pass a mapped value through.
 */
function toFactContract<TOut>(
  fact: ProfileFact<unknown>,
  value: TOut,
): ProfileFactContract<TOut> {
  return {
    id: fact.id,
    value,
    confidence: fact.confidence,
    pinned: fact.pinned,
    source: fact.source,
    provenance: fact.provenance,
    updatedAt: fact.updatedAt,
    conflictsWith: fact.conflictsWith,
  };
}

function toContract(profile: PersonalProfile): ProfileContract {
  return {
    preferences: profile.preferences.map((f) => toFactContract(f, f.value)),
    people: profile.people.map((f) =>
      toFactContract(f, {
        name: f.value.name,
        relationship: f.value.relationship,
        notes: f.value.notes,
      }),
    ),
    projects: profile.projects.map((f) =>
      toFactContract(f, {
        name: f.value.name,
        status: f.value.status,
        description: f.value.description,
      }),
    ),
    routines: profile.routines.map((f) =>
      toFactContract(f, {
        description: f.value.description,
        cadence: f.value.cadence,
      }),
    ),
    communicationStyle: profile.communicationStyle.map((f) => toFactContract(f, f.value)),
    proceduralBlock: profile.proceduralBlock,
    version: profile.version,
    updatedAt: profile.updatedAt,
  };
}

function emptyProfile(): ProfileContract {
  return {
    preferences: [],
    people: [],
    projects: [],
    routines: [],
    communicationStyle: [],
    proceduralBlock: "",
    version: 0,
    updatedAt: new Date().toISOString(),
  };
}

function isDataMissingError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    return msg.includes("no such table") || msg.includes("SQLITE_ERROR") || msg.includes("ENOENT");
  }
  return false;
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest) {
  const t0 = Date.now();
  try {
    const mem = getMemory();
    const profile = await mem.profile.deriveProfile();
    const contract = toContract(profile);

    const isEmpty =
      contract.preferences.length === 0 &&
      contract.people.length === 0 &&
      contract.projects.length === 0 &&
      contract.routines.length === 0 &&
      contract.communicationStyle.length === 0 &&
      !contract.proceduralBlock;

    const envelope: WidgetEnvelope<ProfileContract> = {
      data: contract,
      state: isEmpty ? "empty" : "ok",
      meta: {
        source: "memory-profile",
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    if (isDataMissingError(err)) {
      const envelope: WidgetEnvelope<ProfileContract> = {
        data: emptyProfile(),
        state: "empty",
        meta: {
          source: "none",
          fetchedAt: new Date().toISOString(),
          latencyMs: Date.now() - t0,
        },
      };
      return NextResponse.json(envelope);
    }

    const envelope: WidgetEnvelope<ProfileContract> = {
      data: null,
      state: "error",
      error: {
        code: "PROFILE_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
      meta: {
        source: "none",
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}

// ── PATCH — correctFact ────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  const t0 = Date.now();
  try {
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
    if (typeof correction === "string" && typeof pinned === "boolean") {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "send either correction or pinned, not both" } },
        { status: 400 },
      );
    }

    const mem = getMemory();
    const profile =
      typeof pinned === "boolean"
        ? await mem.profile.setPinned(factId, pinned)
        : await mem.profile.correctFact({ factId, correction: correction! });
    const contract = toContract(profile);

    const envelope: WidgetEnvelope<ProfileContract> = {
      data: contract,
      state: "ok",
      meta: {
        source: "memory-profile",
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<ProfileContract> = {
      data: null,
      state: "error",
      error: {
        code: "CORRECT_FACT_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
      meta: {
        source: "none",
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}

// ── DELETE — forgetEntity (by name) or forgetFact (by fact id) ────────────────

export async function DELETE(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { entityName?: string; factId?: string };
    const { entityName, factId } = body;

    const hasEntity = typeof entityName === "string" && entityName.length > 0;
    const hasFact = typeof factId === "string" && factId.length > 0;
    if (hasEntity === hasFact) {
      // neither, or ambiguously both
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "send exactly one of entityName or factId" } },
        { status: 400 },
      );
    }

    const mem = getMemory();
    const profile = hasFact
      ? await mem.profile.forgetFact(factId!)
      : await mem.profile.forgetEntity({ entityName: entityName! });
    const contract = toContract(profile);

    const envelope: WidgetEnvelope<ProfileContract> = {
      data: contract,
      state: "ok",
      meta: {
        source: "memory-profile",
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<ProfileContract> = {
      data: null,
      state: "error",
      error: {
        code: "FORGET_ENTITY_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
      meta: {
        source: "none",
        fetchedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
      },
    };
    return NextResponse.json(envelope, { status: 500 });
  }
}
