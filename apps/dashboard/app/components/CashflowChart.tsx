"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { CashflowMonthContract } from "@/app/lib/contracts";
import { toMajor } from "@/app/lib/money";

// HUD theme tokens (mirror globals.css — Recharts needs literal values)
const GRID_STROKE = "rgba(74, 160, 255, 0.12)";
const TICK_FILL = "#4d6781";
const INCOME_COLOR = "#38c6ff";
const EXPENSES_COLOR = "rgba(127, 160, 200, 0.55)";
const TOOLTIP_STYLE = {
  background: "#081424",
  border: "1px solid rgba(99, 201, 255, 0.45)",
  borderRadius: 3,
  fontSize: 12,
} as const;

export default function CashflowChart({ months }: { months: CashflowMonthContract[] }) {
  const data = months.map((m) => ({
    month: m.month,
    income: toMajor(m.incomeMinor),
    expenses: toMajor(m.expensesMinor),
  }));

  return (
    <div className="metric-chart">
      <div className="metric-chart__title">Income vs Expenses</div>
      <div style={{ width: "100%", height: 220 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: TICK_FILL }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: TICK_FILL }} tickLine={false} axisLine={false} width={48} />
            <Tooltip
              cursor={{ fill: "rgba(56, 198, 255, 0.06)" }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: TICK_FILL }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: TICK_FILL }} />
            <Bar dataKey="income" fill={INCOME_COLOR} fillOpacity={0.85} radius={[2, 2, 0, 0]} />
            <Bar dataKey="expenses" fill={EXPENSES_COLOR} fillOpacity={0.75} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
