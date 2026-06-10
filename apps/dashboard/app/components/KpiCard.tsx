import type { KpiValue } from "@/app/lib/contracts";

interface KpiCardProps {
  kpi: KpiValue;
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return "--";
  if (unit === "min") {
    const h = Math.floor(value / 60);
    const m = Math.round(value % 60);
    return h > 0 ? `${h}h${m > 0 ? `${m}m` : ""}` : `${m}m`;
  }
  if (unit === "%") return `${Math.round(value)}%`;
  if (unit === "count") return String(Math.round(value));
  if (unit === "ms") return `${Math.round(value)}ms`;
  return `${Number(value.toFixed(1))} ${unit}`;
}

function trendArrow(trend?: "up" | "down" | "flat"): string {
  if (trend === "up") return " +";
  if (trend === "down") return " -";
  return "";
}

export default function KpiCard({ kpi }: KpiCardProps) {
  const { label, value, unit, trend, asOf, stale, sourceConnected } = kpi;

  return (
    <div className={`kpi-card${stale ? " kpi-card--stale" : ""}${!sourceConnected ? " kpi-card--disconnected" : ""}`}>
      <div className="kpi-card__label">{label}</div>
      <div className="kpi-card__value">
        {formatValue(value, unit)}
        {trend && <span className={`kpi-card__trend kpi-card__trend--${trend}`}>{trendArrow(trend)}</span>}
      </div>
      <div className="kpi-card__footer">
        {stale && <span className="badge-stale">T+1</span>}
        {!sourceConnected && <span className="badge-disconnected">disconnected</span>}
        {!stale && sourceConnected && (
          <span className="kpi-card__asof">
            {new Date(asOf).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
        )}
      </div>
    </div>
  );
}
