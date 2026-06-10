/**
 * Models settings — placeholder. Model load/unload via feature 1 (future).
 */

import ModelStatusBadge from "@/app/components/ModelStatusBadge";

export default function ModelsPage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Models</h1>
        <p className="text-dim text-sm">Manage local inference models.</p>
      </div>
      <div className="card">
        <div className="card__title">Current Model</div>
        <ModelStatusBadge />
        <p className="text-dim text-sm" style={{ marginTop: 12 }}>
          Model load/unload, profile switching, and VRAM monitoring arrive with feature 1 (full inference core).
        </p>
      </div>
    </div>
  );
}
