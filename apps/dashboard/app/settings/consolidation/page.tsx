/**
 * Consolidation — MEM-03. Live pending/consolidated/dead-letter counts and
 * last-pass status from memory.db, fetched fresh on every navigation
 * (fetchEnvelope's cache: "no-store" — no client polling, per the locked
 * "minimal UI" decision).
 */

import type { WidgetEnvelope, ConsolidationHealthContract } from "@/app/lib/contracts";
import ConsolidationHealthPanel from "@/app/components/ConsolidationHealthPanel";
import { fetchEnvelope } from "@/app/lib/fetchEnvelope";

function fetchConsolidationHealth(): Promise<WidgetEnvelope<ConsolidationHealthContract>> {
  return fetchEnvelope<ConsolidationHealthContract>("/api/memory/health");
}

export default async function ConsolidationPage() {
  const env = await fetchConsolidationHealth();

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">System</div>
        <h1 className="page-title">Consolidation</h1>
        <p className="text-dim text-sm">Nightly memory consolidation status.</p>
      </div>
      <ConsolidationHealthPanel envelope={env} />
    </div>
  );
}
