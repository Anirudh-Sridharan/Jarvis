/**
 * GET /api/briefing?date=YYYY-MM-DD  — assemble latest briefing (template fallback)
 *
 * Since the LLM is injected as a no-op stub (dashboard is read-only),
 * assembleBriefing() always uses the deterministic template fallback.
 * Returns WidgetEnvelope<BriefingContract>.
 * Never 500 on empty data — returns state:"empty".
 */

import { NextRequest, NextResponse } from "next/server";
import type { WidgetEnvelope, BriefingContract } from "@/app/lib/contracts";
import { getIntegrations } from "@/app/lib/services";

export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const date = req.nextUrl.searchParams.get("date") ?? todayDate();

  try {
    const { briefing } = getIntegrations();
    const doc = await briefing.assembleBriefing(date);

    const envelope: WidgetEnvelope<BriefingContract> = {
      data: {
        id: doc.id,
        date: doc.date,
        status: doc.status,
        generatedBy: doc.generatedBy,
        markdown: doc.markdown,
        createdAt: doc.createdAt,
      },
      state: doc.markdown.trim() ? "ok" : "empty",
      meta: { source: "briefing-service", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    // If all data is missing / no sqlite yet, return empty not error
    const isDataMissing =
      err instanceof Error &&
      (err.message.includes("no such table") || err.message.includes("SQLITE_ERROR"));

    const envelope: WidgetEnvelope<BriefingContract> = {
      data: null,
      state: isDataMissing ? "empty" : "error",
      error: isDataMissing
        ? undefined
        : { code: "BRIEFING_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}
