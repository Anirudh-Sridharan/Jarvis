"use client";

/**
 * ProfileView — renders all PersonalProfile facets.
 *
 * Handles empty/error states.
 * Each ProfileFact shows a "This is wrong" (correctFact) or "Forget" affordance
 * that calls PATCH /api/profile or DELETE /api/profile.
 *
 * The procedural block is rendered as pre-formatted markdown.
 */

import { useState, useTransition } from "react";
import type {
  WidgetEnvelope,
  ProfileContract,
  ProfileFactContract,
  PersonContract,
  ProjectContract,
  RoutineContract,
} from "@/app/lib/contracts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const cls =
    pct >= 80 ? "badge-confidence badge-confidence--high"
    : pct >= 50 ? "badge-confidence badge-confidence--mid"
    : "badge-confidence badge-confidence--low";
  return <span className={cls}>{pct}%</span>;
}

function SourceBadge({ source }: { source: "derived" | "user" }) {
  return (
    <span className={`badge-source badge-source--${source}`}>
      {source === "user" ? "you" : "derived"}
    </span>
  );
}

// ── Fact card with correction/forget affordances ──────────────────────────────

interface FactCardProps<T> {
  fact: ProfileFactContract<T>;
  label: string;
  onCorrect: (factId: string, correction: string) => void;
  onPin: (factId: string, pinned: boolean) => void;
  /** Entity-level forget (people/projects): invalidates the whole group. */
  onForget?: (entityName: string) => void;
  entityName?: string;
  /** Per-fact forget (preferences/routines/style): invalidates this fact only. */
  onForgetFact?: (factId: string) => void;
}

function FactCard<T extends string | PersonContract | ProjectContract | RoutineContract>({
  fact,
  label,
  onCorrect,
  onPin,
  onForget,
  entityName,
  onForgetFact,
}: FactCardProps<T>) {
  const [editing, setEditing] = useState(false);
  const [correction, setCorrection] = useState("");

  function handleSubmitCorrection(e: React.FormEvent) {
    e.preventDefault();
    if (correction.trim()) {
      onCorrect(fact.id, correction.trim());
      setEditing(false);
      setCorrection("");
    }
  }

  return (
    <div className="fact-card">
      <div className="fact-card__header">
        <span className="fact-card__label">{label}</span>
        <div className="fact-card__badges">
          <ConfidenceBadge confidence={fact.confidence} />
          <SourceBadge source={fact.source} />
          {fact.pinned && <span className="badge-pinned">pinned</span>}
          {fact.conflictsWith && fact.conflictsWith.length > 0 && (
            <span
              className="badge-conflict"
              title="Conflicts with another learned fact — correct or forget the wrong one"
            >
              conflict
            </span>
          )}
        </div>
      </div>

      {fact.provenance && (
        <div className="fact-card__provenance text-dim text-sm">{fact.provenance}</div>
      )}

      {editing ? (
        <form onSubmit={handleSubmitCorrection} className="fact-card__edit-form">
          <input
            className="fact-card__input"
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="Enter correct value…"
            autoFocus
          />
          <div className="fact-card__edit-actions">
            <button type="submit" className="btn btn--sm btn--primary">Save</button>
            <button type="button" className="btn btn--sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="fact-card__actions">
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => onPin(fact.id, !fact.pinned)}
            title={
              fact.pinned
                ? "Unpin — allow consolidation to update this"
                : "Confirm — never auto-overwritten by consolidation"
            }
          >
            {fact.pinned ? "Unpin" : "Confirm"}
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => setEditing(true)}
            title="This is wrong — correct it"
          >
            This is wrong
          </button>
          {onForget && entityName ? (
            <button
              className="btn btn--sm btn--ghost btn--danger"
              onClick={() => onForget(entityName)}
              title="Forget this"
            >
              Forget
            </button>
          ) : onForgetFact ? (
            <button
              className="btn btn--sm btn--ghost btn--danger"
              onClick={() => onForgetFact(fact.id)}
              title="Forget this fact"
            >
              Forget
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Facet section ─────────────────────────────────────────────────────────────

function FacetSection({ title, children, empty }: {
  title: string;
  children: React.ReactNode;
  empty?: string;
}) {
  return (
    <section className="profile-section">
      <h2 className="profile-section__title">{title}</h2>
      {children ?? <p className="text-dim text-sm">{empty ?? "Nothing learned yet."}</p>}
    </section>
  );
}

// ── Main ProfileView ──────────────────────────────────────────────────────────

interface ProfileViewProps {
  envelope: WidgetEnvelope<ProfileContract>;
}

export default function ProfileView({ envelope }: ProfileViewProps) {
  const [profile, setProfile] = useState<ProfileContract | null>(envelope.data);
  const [error, setError] = useState<string | null>(
    envelope.state === "error" ? (envelope.error?.message ?? "Failed to load profile") : null,
  );
  const [isPending, startTransition] = useTransition();

  // ── Action handlers ─────────────────────────────────────────────────────────

  async function handleCorrect(factId: string, correction: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ factId, correction }),
        });
        const env = (await res.json()) as WidgetEnvelope<ProfileContract>;
        if (env.data) setProfile(env.data);
        else if (env.error) setError(env.error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Correction failed");
      }
    });
  }

  async function handlePin(factId: string, pinned: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ factId, pinned }),
        });
        const env = (await res.json()) as WidgetEnvelope<ProfileContract>;
        if (env.data) setProfile(env.data);
        else if (env.error) setError(env.error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Pin update failed");
      }
    });
  }

  async function handleForget(entityName: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entityName }),
        });
        const env = (await res.json()) as WidgetEnvelope<ProfileContract>;
        if (env.data) setProfile(env.data);
        else if (env.error) setError(env.error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Forget failed");
      }
    });
  }

  async function handleForgetFact(factId: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/profile", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ factId }),
        });
        const env = (await res.json()) as WidgetEnvelope<ProfileContract>;
        if (env.data) setProfile(env.data);
        else if (env.error) setError(env.error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Forget failed");
      }
    });
  }

  // ── Empty / error states ────────────────────────────────────────────────────

  if (error && !profile) {
    return (
      <div className="card card--error">
        <div className="card__title">Profile</div>
        <p className="text-error text-sm">{error}</p>
      </div>
    );
  }

  const isEmpty =
    !profile ||
    (profile.preferences.length === 0 &&
      profile.people.length === 0 &&
      profile.projects.length === 0 &&
      profile.routines.length === 0 &&
      profile.communicationStyle.length === 0 &&
      !profile.proceduralBlock);

  if (isEmpty) {
    return (
      <div className="card state-card">
        <div className="card__title">Getting to know you</div>
        <p className="text-dim">
          Jarvis is still learning about you. Chat more or seed some facts to build your profile.
        </p>
        <a href="/chat" className="link-cta">Start chatting</a>
      </div>
    );
  }

  // ── Populated ───────────────────────────────────────────────────────────────

  return (
    <div className={`profile-view${isPending ? " profile-view--pending" : ""}`}>
      {error && (
        <div className="profile-error-banner text-error text-sm">{error}</div>
      )}

      {/* Preferences */}
      <FacetSection title="Preferences">
        {profile.preferences.length > 0 ? (
          <div className="fact-list">
            {profile.preferences.map((f) => (
              <FactCard
                key={f.id}
                fact={f}
                label={f.value}
                onCorrect={handleCorrect}
                onPin={handlePin}
                onForgetFact={handleForgetFact}
              />
            ))}
          </div>
        ) : (
          <p className="text-dim text-sm">No preferences learned yet.</p>
        )}
      </FacetSection>

      {/* People */}
      <FacetSection title="People">
        {profile.people.length > 0 ? (
          <div className="fact-list">
            {profile.people.map((f) => (
              <FactCard
                key={f.id}
                fact={f}
                label={
                  `${f.value.name}${f.value.relationship ? ` (${f.value.relationship})` : ""}${
                    f.value.notes ? ` — ${f.value.notes}` : ""
                  }`
                }
                onCorrect={handleCorrect}
                onPin={handlePin}
                onForget={handleForget}
                entityName={f.value.name}
              />
            ))}
          </div>
        ) : (
          <p className="text-dim text-sm">No people learned yet.</p>
        )}
      </FacetSection>

      {/* Projects */}
      <FacetSection title="Projects">
        {profile.projects.length > 0 ? (
          <div className="fact-list">
            {profile.projects.map((f) => (
              <FactCard
                key={f.id}
                fact={f}
                label={
                  `${f.value.name} [${f.value.status}]${
                    f.value.description ? ` — ${f.value.description}` : ""
                  }`
                }
                onCorrect={handleCorrect}
                onPin={handlePin}
                onForget={handleForget}
                entityName={f.value.name}
              />
            ))}
          </div>
        ) : (
          <p className="text-dim text-sm">No projects learned yet.</p>
        )}
      </FacetSection>

      {/* Routines */}
      <FacetSection title="Routines">
        {profile.routines.length > 0 ? (
          <div className="fact-list">
            {profile.routines.map((f) => (
              <FactCard
                key={f.id}
                fact={f}
                label={
                  `${f.value.description}${f.value.cadence ? ` (${f.value.cadence})` : ""}`
                }
                onCorrect={handleCorrect}
                onPin={handlePin}
                onForgetFact={handleForgetFact}
              />
            ))}
          </div>
        ) : (
          <p className="text-dim text-sm">No routines learned yet.</p>
        )}
      </FacetSection>

      {/* Communication style */}
      <FacetSection title="Communication Style">
        {profile.communicationStyle.length > 0 ? (
          <div className="fact-list">
            {profile.communicationStyle.map((f) => (
              <FactCard
                key={f.id}
                fact={f}
                label={f.value}
                onCorrect={handleCorrect}
                onPin={handlePin}
                onForgetFact={handleForgetFact}
              />
            ))}
          </div>
        ) : (
          <p className="text-dim text-sm">No style preferences learned yet.</p>
        )}
      </FacetSection>

      {/* Procedural block */}
      <FacetSection title="How I Like to Work">
        {profile.proceduralBlock ? (
          <div className="procedural-block">
            <pre className="procedural-block__content">{profile.proceduralBlock}</pre>
            <p className="text-dim text-sm procedural-block__hint">
              Written by nightly consolidation. To update, correct individual facts above.
            </p>
          </div>
        ) : (
          <p className="text-dim text-sm">Procedural block not yet generated.</p>
        )}
      </FacetSection>

      <div className="profile-meta text-dim text-sm">
        Profile v{profile.version} · last updated {profile.updatedAt.slice(0, 10)}
      </div>
    </div>
  );
}
