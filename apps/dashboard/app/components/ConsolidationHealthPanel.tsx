import type { WidgetEnvelope, ConsolidationHealthContract } from "@/app/lib/contracts";

interface ConsolidationHealthPanelProps {
  envelope: WidgetEnvelope<ConsolidationHealthContract>;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * MEM-03: read-only consolidation-health panel — three count tiles
 * (pending/consolidated/dead-letter) plus a last-run card. RSC-fed (props
 * only, no fetching/effects), mirroring KpiCard/MemoryList, not
 * TelemetryPanel/ConnectorPanel (which poll client-side).
 *
 * needsAttention is derived from lastRun.errors.length > 0 OR
 * deadLetterCount > 0 — never from lastRun.status. Per 12-RESEARCH.md
 * Pitfall 1, ConsolidationService never persists a "did not complete" status
 * value onto consolidation_runs.status; a stage failure surfaces as
 * "partial" (with non-empty errors), not a dedicated failure marker. Gating
 * on status alone would make a forced consolidation failure invisible.
 */
export default function ConsolidationHealthPanel({ envelope }: ConsolidationHealthPanelProps) {
  if (envelope.state === "error") {
    return (
      <div className="card card--error">
        <div className="card__title">Consolidation</div>
        <p className="text-error text-sm">
          {envelope.error?.message ?? "Failed to load consolidation health"}
        </p>
      </div>
    );
  }

  const health = envelope.data ?? {
    pendingCount: 0,
    consolidatedCount: 0,
    deadLetterCount: 0,
    lastRun: null,
  };
  const { pendingCount, consolidatedCount, deadLetterCount, lastRun } = health;

  const needsAttention = (lastRun?.errors.length ?? 0) > 0 || deadLetterCount > 0;

  return (
    <div>
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-card__label">Pending</div>
          <div className="kpi-card__value">{pendingCount}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__label">Consolidated</div>
          <div className="kpi-card__value">{consolidatedCount}</div>
        </div>
        <div className={`kpi-card${deadLetterCount > 0 ? " kpi-card--stale" : ""}`}>
          <div className="kpi-card__label">Dead-letter</div>
          <div className="kpi-card__value">{deadLetterCount}</div>
        </div>
      </div>

      <div className={`card${needsAttention ? " card--error" : ""}`} style={{ marginTop: 16 }}>
        <div className="card__title">Last Run</div>
        {!lastRun ? (
          <p className="text-dim">No consolidation runs recorded yet.</p>
        ) : (
          <>
            <p>
              <span className={needsAttention ? "text-error" : "connector-ok"}>{lastRun.status}</span>
              <span className="text-dim text-sm">
                {" "}
                · {lastRun.trigger} · started {formatTimestamp(lastRun.startedAt)}
                {lastRun.finishedAt ? ` · finished ${formatTimestamp(lastRun.finishedAt)}` : ""}
              </span>
            </p>
            {needsAttention && (
              <p className="text-error text-sm" style={{ marginTop: 8 }}>
                Needs attention:{" "}
                {lastRun.errors.length > 0
                  ? `${lastRun.errors.length} error(s) in the last pass`
                  : `${deadLetterCount} dead-lettered record(s)`}
              </p>
            )}
            {lastRun.errors.length > 0 && (
              <ul className="text-error text-sm" style={{ marginTop: 8 }}>
                {lastRun.errors.map((e, i) => (
                  <li key={`${e.stage}-${i}`}>
                    stage {e.stage}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
