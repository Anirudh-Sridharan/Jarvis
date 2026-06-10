/**
 * Integrations settings — placeholder for connect/reconnect per source.
 * Phase 4: status display only; OAuth flows are feature 9 (future).
 */

const SOURCES = [
  { id: "whoop", label: "WHOOP", desc: "Sleep, recovery, HRV, strain." },
  { id: "apple_health", label: "Apple Health", desc: "Steps, heart rate, workouts." },
  { id: "gcal", label: "Google Calendar", desc: "Events and agenda." },
  { id: "github", label: "GitHub", desc: "Commits, PRs, code activity." },
  { id: "gmail", label: "Gmail", desc: "Email metrics and summaries." },
];

export default function IntegrationsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Integrations</h1>
        <p className="text-dim text-sm">Connect data sources to power your dashboard.</p>
      </div>
      <div className="settings-list">
        {SOURCES.map((s) => (
          <div key={s.id} className="settings-item">
            <div className="settings-item__label">{s.label}</div>
            <p className="settings-item__desc text-dim text-sm">{s.desc}</p>
            <span className="badge-pill">Not connected</span>
          </div>
        ))}
      </div>
      <p className="text-dim text-sm" style={{ marginTop: 16 }}>
        OAuth connection flows arrive with feature 9.
      </p>
    </div>
  );
}
