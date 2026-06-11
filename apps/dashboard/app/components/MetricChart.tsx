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
const GRID_STROKE = "rgba(74, 160, 255, 0.12)";
const TICK_FILL = "#4d6781";
const TOOLTIP_STYLE = {
  background: "#081424",
  border: "1px solid rgba(99, 201, 255, 0.45)",
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
  color = "#38c6ff",
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
                cursor={{ fill: "rgba(56, 198, 255, 0.06)" }}
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
                cursor={{ stroke: "rgba(127, 220, 255, 0.25)" }}
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
                activeDot={{ r: 4, fill: "#eaffff", stroke: "rgba(127, 220, 255, 0.45)", strokeWidth: 4 }}
                connectNulls={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
