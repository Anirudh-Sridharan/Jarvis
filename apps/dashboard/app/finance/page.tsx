/**
 * Finance — feature 11 — v2 placeholder.
 * No data fetched; greyed cards with "Planned for v2" ribbon.
 */

import { PlaceholderCard } from "@/app/components/WidgetStates";

export default function FinancePage() {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Finance</h1>
        <p className="text-dim text-sm">Coming in v2</p>
      </div>

      <div className="kpi-row">
        <PlaceholderCard title="Net Worth" />
        <PlaceholderCard title="Monthly Spend" />
        <PlaceholderCard title="Savings Rate" />
        <PlaceholderCard title="Budget vs Actual" />
      </div>

      <div className="chart-grid">
        <PlaceholderCard title="Spend by Category" message="Categorized spend trends — v2." />
        <PlaceholderCard title="Income vs Expenses" message="Monthly cash flow — v2." />
      </div>
    </div>
  );
}
