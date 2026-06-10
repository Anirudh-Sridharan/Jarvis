/**
 * GET  /api/profile       — derive + return the PersonalProfile
 * PATCH /api/profile      — correctFact: { factId, correction } → re-derive profile
 * DELETE /api/profile     — forgetEntity: { entityName } → invalidate all its facts
 *
 * Uses the ProfileService via the memory system (read-instance pattern from services.ts).
 * Degrades gracefully: returns empty profile when no data exists.
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, ProfileContract } from "@/app/lib/contracts";
import { getMemory } from "@/app/lib/services";
import type { PersonalProfile } from "@jarvis/memory";

// ── Shape mapper ──────────────────────────────────────────────────────────────

function toContract(profile: PersonalProfile): ProfileContract {
  return {
    preferences: profile.preferences.map((f) => ({
      id: f.id,
      value: f.value,
      confidence: f.confidence,
      pinned: f.pinned,
      source: f.source,
      provenance: f.provenance,
      updatedAt: f.updatedAt,
    })),
    people: profile.people.map((f) => ({
      id: f.id,
      value: {
        name: f.value.name,
        relationship: f.value.relationship,
        notes: f.value.notes,
      },
      confidence: f.confidence,
      pinned: f.pinned,
      source: f.source,
      provenance: f.provenance,
      updatedAt: f.updatedAt,
    })),
    projects: profile.projects.map((f) => ({
      id: f.id,
      value: {
        name: f.value.name,
        status: f.value.status,
        description: f.value.description,
      },
      confidence: f.confidence,
      pinned: f.pinned,
      source: f.source,
      provenance: f.provenance,
      updatedAt: f.updatedAt,
    })),
    routines: profile.routines.map((f) => ({
      id: f.id,
      value: {
        description: f.value.description,
        cadence: f.value.cadence,
      },
      confidence: f.confidence,
      pinned: f.pinned,
      source: f.source,
      provenance: f.provenance,
      updatedAt: f.updatedAt,
    })),
    communicationStyle: profile.communicationStyle.map((f) => ({
      id: f.id,
      value: f.value,
      confidence: f.confidence,
      pinned: f.pinned,
      source: f.source,
      provenance: f.provenance,
      updatedAt: f.updatedAt,
    })),
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
    const body = (await req.json()) as { factId?: string; correction?: string };
    const { factId, correction } = body;

    if (!factId || typeof correction !== "string") {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "factId and correction are required" } },
        { status: 400 },
      );
    }

    const mem = getMemory();
    const profile = await mem.profile.correctFact({ factId, correction });
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

// ── DELETE — forgetEntity ──────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = (await req.json()) as { entityName?: string };
    const { entityName } = body;

    if (!entityName || typeof entityName !== "string") {
      return NextResponse.json(
        { error: { code: "BAD_REQUEST", message: "entityName is required" } },
        { status: 400 },
      );
    }

    const mem = getMemory();
    const profile = await mem.profile.forgetEntity({ entityName });
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
