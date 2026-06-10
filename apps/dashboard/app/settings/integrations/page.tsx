/**
 * Integrations settings — live connector status (feature 9 surface).
 * Token state from the Keychain, sync history from the integrations DB,
 * manual sync via the connect CLI. OAuth consent itself stays on the CLI
 * (loopback flow needs a browser + local listener): hints are shown inline.
 */

import type { WidgetEnvelope, ConnectorStatusContract } from "@/app/lib/contracts";
import ConnectorPanel from "@/app/components/ConnectorPanel";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

async function fetchConnectors(): Promise<WidgetEnvelope<ConnectorStatusContract[]>> {
  try {
    const res = await fetch(`${BASE}/api/connectors`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<ConnectorStatusContract[]>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

export default async function IntegrationsPage() {
  const envelope = await fetchConnectors();

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Integrations</h1>
        <p className="text-dim text-sm">
          Connection status, sync history, and manual syncs per data source.
        </p>
      </div>
      <ConnectorPanel initialEnvelope={envelope} />
      <p className="text-dim text-sm" style={{ marginTop: 16 }}>
        OAuth consent runs on the CLI (<code>npm run connect -- &lt;source&gt;</code>) — it needs a
        browser and a local callback listener. Once connected, syncs run on schedule with core, or
        on demand from here.
      </p>
    </div>
  );
}
