/**
 * Consolidation — placeholder. Feature 6 (nightly consolidation) is future.
 */

export default function ConsolidationPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">System</div>
        <h1 className="page-title">Consolidation</h1>
        <p className="text-dim text-sm">Nightly memory consolidation status.</p>
      </div>
      <div className="card">
        <div className="card__title">Last Run</div>
        <p className="text-dim">No consolidation runs recorded yet.</p>
        <p className="text-dim text-sm" style={{ marginTop: 12 }}>
          The full consolidation history and controls arrive with feature 6.
        </p>
      </div>
    </div>
  );
}
