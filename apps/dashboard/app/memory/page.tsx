/**
 * Memory Explorer — features 3/4.
 * Read-only browse of recent memories from the local memory store.
 */

import type { WidgetEnvelope, MemoryContract } from "@/app/lib/contracts";
import MemoryList from "@/app/components/MemoryList";
import { fetchEnvelope } from "@/app/lib/fetchEnvelope";

function fetchMemories(q = "recent"): Promise<WidgetEnvelope<MemoryContract[]>> {
  return fetchEnvelope<MemoryContract[]>(`/api/memory?q=${encodeURIComponent(q)}&k=20`);
}

export default async function MemoryPage() {
  const env = await fetchMemories("recent");

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">Memory Core</div>
        <h1 className="page-title">Memory explorer</h1>
        <p className="text-dim text-sm">Recent memories captured from chat, notes, and integrations.</p>
      </div>
      <MemoryList envelope={env} />
    </div>
  );
}
