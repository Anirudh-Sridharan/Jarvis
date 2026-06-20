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
import { fetchEnvelope } from "@/app/lib/fetchEnvelope";

function fetchProfile(): Promise<WidgetEnvelope<ProfileContract>> {
  return fetchEnvelope<ProfileContract>("/api/profile", "Profile service unreachable");
}

export default async function ProfilePage() {
  const envelope = await fetchProfile();

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-eyebrow">Identity</div>
        <h1 className="page-title">Personal profile</h1>
        <p className="text-dim text-sm">
          What Jarvis knows about you — derived from memory. Edit or remove any fact.
        </p>
      </div>
      <ProfileView envelope={envelope} />
    </div>
  );
}
