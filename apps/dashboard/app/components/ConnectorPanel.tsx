"use client";

import { useCallback, useState } from "react";
import type {
  ConnectorStatusContract,
  ConnectorTokenState,
  SyncNowResult,
  WidgetEnvelope,
} from "@/app/lib/contracts";

interface ConnectorPanelProps {
  initialEnvelope: WidgetEnvelope<ConnectorStatusContract[]>;
}

const TOKEN_LABEL: Record<ConnectorTokenState, string> = {
  connected: "connected",
  expired_refreshable: "expired · refreshable",
  expired_reconsent: "re-consent required",
  not_connected: "not connected",
  "n/a": "—",
};

function tokenBadgeClass(state: ConnectorTokenState): string {
  if (state === "connected") return "connector-badge connector-badge--ok";
  if (state === "not_connected") return "connector-badge";
  return "connector-badge connector-badge--warn";
}

function fmtTs(ts?: string): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ConnectorPanel({ initialEnvelope }: ConnectorPanelProps) {
  const [connectors, setConnectors] = useState<ConnectorStatusContract[]>(
    initialEnvelope.data ?? []
  );
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/connectors", { cache: "no-store" });
      const env = (await res.json()) as WidgetEnvelope<ConnectorStatusContract[]>;
      if (env.data) setConnectors(env.data);
    } catch {
      // keep showing the last known state
    }
  }, []);

  const syncNow = useCallback(
    async (source: string) => {
      if (syncing) return;
      setSyncing(source);
      setSyncMsg((m) => ({ ...m, [source]: { ok: true, text: "syncing…" } }));
      try {
        const res = await fetch("/api/connectors/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source }),
        });
        const env = (await res.json()) as WidgetEnvelope<SyncNowResult>;
        const ok = env.data?.ok ?? false;
        const lastLine =
          env.data?.output.split("\n").filter(Boolean).slice(-2).join(" · ") ??
          env.error?.message ??
          "no output";
        setSyncMsg((m) => ({ ...m, [source]: { ok, text: lastLine } }));
        await refresh();
      } catch (e) {
        setSyncMsg((m) => ({
          ...m,
          [source]: { ok: false, text: e instanceof Error ? e.message : "network error" },
        }));
      } finally {
        setSyncing(null);
      }
    },
    [syncing, refresh]
  );

  if (initialEnvelope.state === "error" && connectors.length === 0) {
    return (
      <div className="card card--error state-card">
        <p className="text-error">{initialEnvelope.error?.message ?? "Connector status unavailable."}</p>
      </div>
    );
  }

  return (
    <div className="connector-list">
      {connectors.map((c) => {
        const msg = syncMsg[c.id];
        const isOpen = expanded === c.id;
        const last = c.lastSync;
        return (
          <div key={c.id} className="card connector-card">
            <div className="connector-card__head">
              <div>
                <div className="settings-item__label">{c.label}</div>
                <p className="settings-item__desc text-dim text-sm">{c.desc}</p>
              </div>
              <div className="connector-card__badges">
                <span className="connector-badge connector-badge--auth">{c.auth}</span>
                <span className={tokenBadgeClass(c.token)}>
                  {TOKEN_LABEL[c.token]}
                  {c.token === "connected" && c.tokenExpiresInMin != null && c.tokenExpiresInMin > 0
                    ? ` · ${c.tokenExpiresInMin}m`
                    : ""}
                </span>
              </div>
            </div>

            <div className="connector-card__meta text-sm">
              <span className="text-dim">schedule</span> {c.scheduleLabel}
              <span className="connector-card__sep">·</span>
              <span className="text-dim">last sync</span>{" "}
              {last ? (
                <>
                  <span className={last.status === "ok" ? "connector-ok" : "text-error"}>
                    {last.status}
                  </span>{" "}
                  {fmtTs(last.startedAt)}
                  {last.status === "ok" && ` · ${last.pointsWritten} points`}
                </>
              ) : c.lastDataAt ? (
                <>data through {fmtTs(c.lastDataAt)}</>
              ) : (
                "never"
              )}
            </div>

            {last?.error && <p className="text-error text-sm">{last.error}</p>}

            {c.token === "not_connected" && c.connectCmd && (
              <p className="connector-card__hint text-sm">
                <span className="text-dim">connect:</span> <code>{c.connectCmd}</code>
              </p>
            )}

            <div className="connector-card__actions">
              {c.syncable && (
                <button
                  className="btn btn--sm btn--primary"
                  onClick={() => void syncNow(c.id)}
                  disabled={syncing !== null}
                >
                  {syncing === c.id ? "Syncing…" : "Sync now"}
                </button>
              )}
              {c.recentRuns.length > 0 && (
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => setExpanded(isOpen ? null : c.id)}
                >
                  {isOpen ? "Hide runs" : `Runs (${c.recentRuns.length})`}
                </button>
              )}
              {msg && (
                <span className={`text-sm ${msg.ok ? "connector-ok" : "text-error"}`}>
                  {msg.text}
                </span>
              )}
            </div>

            {isOpen && (
              <ul className="connector-runs">
                {c.recentRuns.map((r) => (
                  <li key={r.id} className="connector-runs__item text-sm">
                    <span className={r.status === "ok" ? "connector-ok" : r.status === "error" ? "text-error" : "text-dim"}>
                      {r.status}
                    </span>
                    <span className="text-dim">{fmtTs(r.startedAt)}</span>
                    <span>{r.trigger}</span>
                    <span>{r.pointsWritten} pts</span>
                    {r.error && <span className="text-error connector-runs__err">{r.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
