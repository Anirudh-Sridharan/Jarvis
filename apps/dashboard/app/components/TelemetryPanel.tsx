"use client";

import { useEffect, useState } from "react";

import { CORE_URL } from "@/app/lib/clientEnv";

const POLL_MS = 15_000;

// Mirrors core GET /telemetry: { ok, summary, recent }
interface TelemetrySummary {
  sinceHours: number;
  turns: number;
  avgTtftMs: number | null;
  avgTokensPerSec: number | null;
  byTarget: Record<string, number>;
  fallbackTurns: number;
}

interface TelemetryRow {
  ts: string;
  kind: "routing" | "turn";
  target: string;
  modelId: string;
  ttftMs?: number;
  tokens?: number;
  durationMs?: number;
  fallback?: boolean;
}

interface TelemetryResponse {
  ok: boolean;
  summary: TelemetrySummary;
  recent: TelemetryRow[];
}

export default function TelemetryPanel() {
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`${CORE_URL}/telemetry?limit=8`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as TelemetryResponse;
        if (cancelled) return;
        setData(json);
        setUnreachable(false);
      } catch {
        if (!cancelled) setUnreachable(true);
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (unreachable) {
    return <p className="text-dim text-sm">Telemetry unavailable — core offline.</p>;
  }
  if (!data) {
    return <p className="text-dim text-sm">Loading telemetry…</p>;
  }

  const s = data.summary;
  const targetSplit = Object.entries(s.byTarget)
    .map(([target, n]) => `${target} ${n}`)
    .join(" · ");
  const recentTurns = data.recent.filter((r) => r.kind === "turn");

  return (
    <div>
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-card__label">Turns ({s.sinceHours}h)</div>
          <div className="kpi-card__value">{s.turns}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__label">Avg TTFT</div>
          <div className="kpi-card__value">
            {s.avgTtftMs != null ? `${s.avgTtftMs}ms` : "—"}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__label">Avg tok/s</div>
          <div className="kpi-card__value">
            {s.avgTokensPerSec != null ? s.avgTokensPerSec : "—"}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-card__label">Fallbacks</div>
          <div className="kpi-card__value">{s.fallbackTurns}</div>
        </div>
      </div>

      {targetSplit && (
        <p className="text-dim text-sm" style={{ marginTop: 8 }}>
          Routing: {targetSplit}
        </p>
      )}

      {recentTurns.length > 0 && (
        <ul className="text-dim text-sm" style={{ marginTop: 8, listStyle: "none", padding: 0 }}>
          {recentTurns.slice(0, 5).map((r, i) => (
            <li key={`${r.ts}-${i}`} style={{ display: "flex", gap: 8 }}>
              <span>{r.ts.slice(11, 19)}</span>
              <span>{r.target}</span>
              <span>{r.ttftMs != null && r.ttftMs >= 0 ? `${r.ttftMs}ms ttft` : "no token"}</span>
              <span>{r.tokens ?? 0} tok</span>
              {r.fallback ? <span>fallback</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
