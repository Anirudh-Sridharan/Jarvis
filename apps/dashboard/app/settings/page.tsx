/**
 * Settings overview — links to sub-sections.
 */

import Link from "next/link";

const SECTIONS = [
  { href: "/settings/integrations", label: "Integrations", desc: "Connect sources: WHOOP, Apple Health, Google Calendar, GitHub, Gmail." },
  { href: "/settings/models", label: "Models", desc: "Load/unload local models, switch profile, monitor VRAM." },
  { href: "/settings/approvals", label: "Approvals", desc: "Review pending approvals and audit log." },
  { href: "/settings/consolidation", label: "Consolidation", desc: "Nightly consolidation status and history." },
];

export default function SettingsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="settings-list">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="settings-item">
            <div className="settings-item__label">{s.label}</div>
            <p className="settings-item__desc text-dim text-sm">{s.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
