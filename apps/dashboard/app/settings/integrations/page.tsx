/**
 * Integrations settings — live connector status (feature 9 surface).
 * Token state from the Keychain, sync history from the integrations DB,
 * manual sync via the connect CLI. OAuth consent itself stays on the CLI
 * (loopback flow needs a browser + local listener): hints are shown inline.
 */

import type { WidgetEnvelope, ConnectorStatusContract } from "@/app/lib/contracts";
import ConnectorPanel from "@/app/components/ConnectorPanel";
import { fetchEnvelope } from "@/app/lib/fetchEnvelope";

function fetchConnectors(): Promise<WidgetEnvelope<ConnectorStatusContract[]>> {
  return fetchEnvelope<ConnectorStatusContract[]>("/api/connectors");
}

export default async function IntegrationsPage() {
  const envelope = await fetchConnectors();

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">System</div>
        <h1 className="page-title">Integrations</h1>
        <p className="text-dim text-sm">
          Connection status, sync history, and manual syncs per data source.
        </p>
      </div>
      <ConnectorPanel initialEnvelope={envelope} />
      <p className="text-dim text-sm" style={{ marginTop: 16 }}>
        Connect launches the provider&apos;s consent page in your browser (loopback OAuth via the
        connect CLI; tokens land in the macOS Keychain). Once connected, syncs run on schedule
        with core, or on demand from here.
      </p>
    </div>
  );
}
