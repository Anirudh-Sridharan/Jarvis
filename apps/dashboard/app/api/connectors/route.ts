/**
 * GET /api/connectors — per-source connection + sync status.
 *
 * Returns WidgetEnvelope<ConnectorStatusContract[]>.
 * Token presence is read from the macOS Keychain (read-only), sync history
 * from the integrations DB. Never 500s — errors come back in the envelope.
 */

import { NextResponse } from "next/server";
import type { WidgetEnvelope, ConnectorStatusContract } from "@/app/lib/contracts";
import { getConnectorStatuses } from "@/app/lib/connectorStatus";

export async function GET() {
  const t0 = Date.now();
  try {
    const statuses = await getConnectorStatuses();
    const envelope: WidgetEnvelope<ConnectorStatusContract[]> = {
      data: statuses,
      state: "ok",
      meta: { source: "keychain+local-sqlite", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  } catch (err) {
    const envelope: WidgetEnvelope<ConnectorStatusContract[]> = {
      data: null,
      state: "error",
      error: { code: "STATUS_ERROR", message: err instanceof Error ? err.message : String(err) },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: Date.now() - t0 },
    };
    return NextResponse.json(envelope);
  }
}
