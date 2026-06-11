/**
 * Approvals — placeholder. Feature 17 (action approval gate) is future.
 */

export default function ApprovalsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">System</div>
        <h1 className="page-title">Approvals</h1>
        <p className="text-dim text-sm">Pending actions and audit log.</p>
      </div>
      <div className="card">
        <div className="card__title">Approval Queue</div>
        <p className="text-dim">No pending approvals.</p>
        <p className="text-dim text-sm" style={{ marginTop: 12 }}>
          The full approval/audit queue arrives with feature 17 (action safety gate).
        </p>
      </div>
    </div>
  );
}
