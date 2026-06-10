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

function formatTick(ts: string): string {
  const d = new Date(ts.length === 10 ? ts + "T12:00:00Z" : ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MetricChart({
  points,
  label,
  unit = "",
  kind = "line",
  color = "#5eead4",
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
              <CartesianGrid strokeDasharray="3 3" stroke="#262b33" vertical={false} />
              <XAxis dataKey="ts" tick={{ fontSize: 10, fill: "#8a93a3" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#8a93a3" }} tickLine={false} axisLine={false} width={36} />
              <Tooltip
                contentStyle={{ background: "#14171c", border: "1px solid #262b33", borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: "#8a93a3" }}
                itemStyle={{ color: color }}
              />
              <Bar dataKey="value" fill={color} radius={[2, 2, 0, 0]} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262b33" vertical={false} />
              <XAxis dataKey="ts" tick={{ fontSize: 10, fill: "#8a93a3" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#8a93a3" }} tickLine={false} axisLine={false} width={36} />
              <Tooltip
                contentStyle={{ background: "#14171c", border: "1px solid #262b33", borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: "#8a93a3" }}
                itemStyle={{ color: color }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
