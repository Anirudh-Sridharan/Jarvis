/**
 * GET /api/memory?q=<query>&k=10  — retrieve recent memories
 *
 * Uses the memory retrieval service with a stub embedder (returns empty vector).
 * Falls back to returning empty on any error.
 * Returns WidgetEnvelope<MemoryContract[]>.
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, MemoryContract } from "@/app/lib/contracts";
import { getMemory } from "@/app/lib/services";
import type { RetrievedMemory } from "@jarvis/memory";

function toContract(m: RetrievedMemory): MemoryContract {
  return {
    memoryId: m.memoryId,
    text: m.text,
    kind: m.kind,
    validFrom: m.validFrom,
    fusedScore: m.fusedScore,
  };
}

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const q = req.nextUrl.searchParams.get("q") ?? "recent";
  const k = Math.min(parseInt(req.nextUrl.searchParams.get("k") ?? "10", 10), 50);

  try {
    const mem = getMemory();
    const results = await mem.retrieval.retrieve(q, { k });
    const contracts = results.map(toContract);

    const envelope: WidgetEnvelope<MemoryContract[]> = {
      data: contracts,
      state: contracts.length === 0 ? "empty" : "ok",
      meta: { source: "memory-store", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const isDataMissing =
      err instanceof Error &&
      (err.message.includes("no such table") || err.message.includes("SQLITE_ERROR"));

    const envelope: WidgetEnvelope<MemoryContract[]> = {
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
