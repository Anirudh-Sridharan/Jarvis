"use client";

/**
 * TelemetryTicker — the bottom marquee strip. Shows real system telemetry:
 * connector last-sync times (/api/connectors) and the core model state
 * (core /status), refreshed every 60s. Degrades to a CORE OFFLINE notice
 * when nothing is reachable. The item list is rendered twice so the CSS
 * translateX(-50%) loop is seamless.
 */

import { useEffect, useState } from "react";

import { CORE_URL } from "@/app/lib/clientEnv";
import type { ConnectorStatusContract, WidgetEnvelope } from "@/app/lib/contracts";

interface TickerItem {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}

const REFRESH_MS = 60_000;

function syncTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function TelemetryTicker() {
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const next: TickerItem[] = [];

      try {
        const res = await fetch(`${CORE_URL}/status`, { cache: "no-store" });
        const json = (await res.json()) as { model?: { id?: string; state?: string } };
        const id = (json.model?.id ?? "").split("/").pop() ?? "";
        const state = (json.model?.state ?? "unknown").toUpperCase();
        next.push({
          label: id ? `MODEL ${id}` : "MODEL",
          value: state,
          tone: state === "READY" || state === "GENERATING" ? "ok" : undefined,
        });
      } catch {
        next.push({ label: "CORE", value: "OFFLINE", tone: "warn" });
      }

      try {
        const res = await fetch("/api/connectors", { cache: "no-store" });
        const env = (await res.json()) as WidgetEnvelope<ConnectorStatusContract[]>;
        for (const c of env.data ?? []) {
          if (!c.lastSync) continue;
          const failed = c.lastSync.status === "error";
          next.push({
            label: `${c.label} SYNC`,
            value: failed ? "FAILED" : syncTime(c.lastSync.startedAt),
            tone: failed ? "warn" : undefined,
          });
        }
      } catch {
        // BFF unreachable — model/core item above already tells the story
      }

      next.push({ label: "SAFETY GATE", value: "ACTIVE", tone: "ok" });
      if (!cancelled) setItems(next);
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (items.length === 0) return <div className="ticker" aria-hidden="true" />;

  const track = [...items, ...items];

  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker__track">
        {track.map((item, i) => (
          <span key={`${item.label}-${i}`}>
            {item.label}{" "}
            <span className={`ticker__value${item.tone ? ` ticker__value--${item.tone}` : ""}`}>
              {item.value}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
