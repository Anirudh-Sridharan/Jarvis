"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { MetricPoint } from "@/app/lib/contracts";

interface MetricChartProps {
  points: MetricPoint[];
  label: string;
  unit?: string;
  kind?: "line" | "bar";
  color?: string;
  downsampled?: boolean;
}

// HUD theme tokens (mirror globals.css — Recharts needs literal values)
const GRID_STROKE = "#16223a";
const TICK_FILL = "#7d8ca6";
const TOOLTIP_STYLE = {
  background: "#090e1a",
  border: "1px solid #24385e",
  borderRadius: 3,
  fontSize: 12,
} as const;

function formatTick(ts: string): string {
  const d = new Date(ts.length === 10 ? ts + "T12:00:00Z" : ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MetricChart({
  points,
  label,
  unit = "",
  kind = "line",
  color = "#60a5fa",
  downsampled,
}: MetricChartProps) {
  const data = points.map((p) => ({
    ts: formatTick(p.ts),
    value: p.value,
  }));

  return (
    <div className="metric-chart">
      <div className="metric-chart__title">
        {label}
        {unit && <span className="metric-chart__unit"> ({unit})</span>}
        {downsampled && <span className="metric-chart__sampled"> sampled</span>}
      </div>
      <div style={{ width: "100%", height: 200 }}>
        <ResponsiveContainer>
          {kind === "bar" ? (
            <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="ts" tick={{ fontSize: 10, fill: TICK_FILL }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: TICK_FILL }} tickLine={false} axisLine={false} width={36} />
              <Tooltip
                cursor={{ fill: "rgba(59, 130, 246, 0.06)" }}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: TICK_FILL }}
                itemStyle={{ color: color }}
              />
              <Bar dataKey="value" fill={color} fillOpacity={0.85} radius={[2, 2, 0, 0]} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="ts" tick={{ fontSize: 10, fill: TICK_FILL }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: TICK_FILL }} tickLine={false} axisLine={false} width={36} />
              <Tooltip
                cursor={{ stroke: "rgba(96, 165, 250, 0.25)" }}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: TICK_FILL }}
                itemStyle={{ color: color }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: color, stroke: "rgba(96, 165, 250, 0.35)", strokeWidth: 4 }}
                connectNulls={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
