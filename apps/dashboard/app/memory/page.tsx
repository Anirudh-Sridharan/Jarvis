/**
 * Memory Explorer — features 3/4.
 * Read-only browse of recent memories from the local memory store.
 */

import type { WidgetEnvelope, MemoryContract } from "@/app/lib/contracts";
import MemoryList from "@/app/components/MemoryList";

import { APP_BASE_URL as BASE } from "@/app/lib/clientEnv";

async function fetchMemories(q = "recent"): Promise<WidgetEnvelope<MemoryContract[]>> {
  try {
    const res = await fetch(
      `${BASE}/api/memory?q=${encodeURIComponent(q)}&k=20`,
      { cache: "no-store" }
    );
    return (await res.json()) as WidgetEnvelope<MemoryContract[]>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

export default async function MemoryPage() {
  const env = await fetchMemories("recent");

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Memory Explorer</h1>
        <p className="text-dim text-sm">Recent memories captured from chat, notes, and integrations.</p>
      </div>
      <MemoryList envelope={env} />
    </div>
  );
}
