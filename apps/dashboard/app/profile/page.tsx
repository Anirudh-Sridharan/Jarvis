/**
 * Profile — feature 20.
 *
 * Shows the PersonalProfile facets derived from semantic memory:
 *   - Preferences, People, Projects, Routines, Communication Style
 *   - The procedural "How I Like to Work" block
 *
 * States:
 *   empty (cold start): "Jarvis is still getting to know you"
 *   error: service/fetch failed
 *   populated: full facets with edit/forget affordances
 *
 * Edit/forget actions are client-side (form POST via fetch → PATCH/DELETE /api/profile).
 */

import type { WidgetEnvelope, ProfileContract } from "@/app/lib/contracts";
import ProfileView from "@/app/components/ProfileView";

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";

async function fetchProfile(): Promise<WidgetEnvelope<ProfileContract>> {
  try {
    const res = await fetch(`${BASE}/api/profile`, { cache: "no-store" });
    return (await res.json()) as WidgetEnvelope<ProfileContract>;
  } catch {
    return {
      data: null,
      state: "error",
      error: { code: "FETCH_ERROR", message: "Profile service unreachable" },
      meta: { source: "none", fetchedAt: new Date().toISOString(), latencyMs: 0 },
    };
  }
}

export default async function ProfilePage() {
  const envelope = await fetchProfile();

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Profile</h1>
        <p className="text-dim text-sm">
          What Jarvis knows about you — derived from memory. Edit or remove any fact.
        </p>
      </div>
      <ProfileView envelope={envelope} />
    </div>
  );
}
