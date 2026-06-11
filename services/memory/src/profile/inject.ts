/**
 * Profile context injection (feature 20 — the spec's inject.ts).
 *
 * Selects the top-N salient facets relevant to a query and renders a compact
 * "## About the user" markdown block for the chat/agent system prompt.
 *
 * Fully deterministic — token-overlap relevance × confidence × recency with a
 * pinned boost. NO LLM: this runs inline on the chat path where AI is banned.
 * Over-personalization guard: relevance-first selection; when nothing matches
 * the query, a small fallback floor (≤3 facets) keeps minimal personalization
 * without locking the model into the whole profile.
 *
 * NOTE(scale): swap token overlap for embedding similarity here if facet
 * counts ever make overlap too coarse — the scoring seam is this file only.
 */
import type { PersonalProfile, ProfileFact, Person, Project, Routine } from "./types.js";

export interface ProfileContextOptions {
  maxFacets?: number; // default 5
  maxChars?: number;  // default 600 (block total, header included)
  now?: Date;         // injectable for tests
}

interface Candidate {
  id: string;
  label: string;
  confidence: number;
  pinned: boolean;
  updatedAt: string;
  conflictsWith: string[];
}

const RECENCY_HALF_LIFE_DAYS = 90;
const PINNED_BOOST = 0.25;
const FALLBACK_FLOOR = 3;
const NOTE_MAX_CHARS = 120;

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

function relevance(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let hits = 0;
  for (const t of queryTokens) if (textTokens.has(t)) hits++;
  return hits / queryTokens.size;
}

function recencyFactor(updatedAt: string, nowMs: number): number {
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) return 0.5;
  const ageDays = Math.max(0, (nowMs - parsed) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function candidate(f: ProfileFact<unknown>, label: string): Candidate {
  return {
    id: f.id,
    label,
    confidence: f.confidence,
    pinned: f.pinned,
    updatedAt: f.updatedAt,
    conflictsWith: f.conflictsWith ?? [],
  };
}

function collectCandidates(p: PersonalProfile): Candidate[] {
  const out: Candidate[] = [];
  for (const f of p.preferences) out.push(candidate(f, `Preference: ${f.value}`));
  for (const f of p.people) {
    const v = f.value as Person;
    const rel = v.relationship ? ` (${v.relationship})` : "";
    const notes = v.notes ? ` — ${truncate(v.notes, NOTE_MAX_CHARS)}` : "";
    out.push(candidate(f, `${v.name}${rel}${notes}`));
  }
  for (const f of p.projects) {
    const v = f.value as Project;
    const desc = v.description ? ` — ${truncate(v.description, NOTE_MAX_CHARS)}` : "";
    out.push(candidate(f, `Project ${v.name} [${v.status}]${desc}`));
  }
  for (const f of p.routines) {
    const v = f.value as Routine;
    const cadence = v.cadence ? ` (${v.cadence})` : "";
    out.push(candidate(f, `Routine: ${v.description}${cadence}`));
  }
  for (const f of p.communicationStyle) {
    out.push(candidate(f, `Communication style: ${f.value}`));
  }
  return out;
}

/** Winner of a conflict pair: pinned > newer > higher confidence. */
function conflictWinner(a: Candidate, b: Candidate): Candidate {
  if (a.pinned !== b.pinned) return a.pinned ? a : b;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.confidence >= b.confidence ? a : b;
}

function dropConflictLosers(cands: Candidate[]): Candidate[] {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const losers = new Set<string>();
  for (const c of cands) {
    if (losers.has(c.id)) continue;
    for (const otherId of c.conflictsWith) {
      const other = byId.get(otherId);
      if (!other || losers.has(other.id)) continue;
      losers.add(conflictWinner(c, other) === c ? other.id : c.id);
      if (losers.has(c.id)) break;
    }
  }
  return cands.filter((c) => !losers.has(c.id));
}

/**
 * Render the profile-context block for a query. Returns "" when the profile
 * has nothing to offer (cold start) — callers omit the block entirely.
 */
export function buildProfileContext(
  profile: PersonalProfile,
  query: string,
  opts: ProfileContextOptions = {},
): string {
  const { maxFacets = 5, maxChars = 600 } = opts;
  const nowMs = (opts.now ?? new Date()).getTime();
  const queryTokens = tokenize(query);

  const candidates = dropConflictLosers(collectCandidates(profile));
  if (candidates.length === 0) return "";

  const scored = candidates.map((c) => {
    const rel = relevance(queryTokens, c.label);
    const base = (0.5 + 0.5 * c.confidence) * recencyFactor(c.updatedAt, nowMs);
    return { c, rel, score: rel * base + (c.pinned ? PINNED_BOOST * rel : 0) };
  });

  let picked = scored
    .filter((s) => s.rel > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, maxFacets);

  if (picked.length === 0) {
    // Fallback floor: minimal personalization when nothing matches the query.
    picked = [...scored]
      .sort(
        (x, y) =>
          Number(y.c.pinned) - Number(x.c.pinned) ||
          y.c.confidence - x.c.confidence ||
          y.c.updatedAt.localeCompare(x.c.updatedAt),
      )
      .slice(0, Math.min(FALLBACK_FLOOR, maxFacets));
  }

  const header = "## About the user";
  const lines: string[] = [];
  let used = header.length;
  for (const { c } of picked) {
    const line = `- ${c.label}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return `${header}\n${lines.join("\n")}`;
}
