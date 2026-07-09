/**
 * GET /api/memory/health — MEM-03 consolidation observability.
 *
 * Reads MemoryStore.getConsolidationHealth() directly against the same
 * memory.db file core's GET /telemetry reads (no HTTP hop to core — mirrors
 * app/api/memory/route.ts's BFF-direct-read shape). Read-only: no writes.
 *
 * Returns WidgetEnvelope<ConsolidationHealthContract>. Note: an empty/fresh
 * DB still returns state:"ok" with all-zero counts + lastRun:null (the schema
 * is created on open, so this never throws) — state:"empty"/"error" are
 * reserved for the no-such-table/SQLITE_ERROR catch path below.
 */

import { NextResponse } from "next/server";
import type { WidgetEnvelope, ConsolidationHealthContract } from "@/app/lib/contracts";
import { getMemory } from "@/app/lib/services";

export async function GET() {
  const t0 = Date.now();
  try {
    const health = getMemory().store.getConsolidationHealth();

    const envelope: WidgetEnvelope<ConsolidationHealthContract> = {
      data: {
        pendingCount: health.pendingCount,
        consolidatedCount: health.consolidatedCount,
        deadLetterCount: health.deadLetterCount,
        lastRun: health.lastRun,
      },
      state: "ok",
      meta: { source: "memory-store", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const isDataMissing =
      err instanceof Error &&
      (err.message.includes("no such table") || err.message.includes("SQLITE_ERROR"));

    const envelope: WidgetEnvelope<ConsolidationHealthContract> = {
      data: null,
      state: isDataMissing ? "empty" : "error",
      error: isDataMissing
        ? undefined
        : { code: "MEMORY_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
