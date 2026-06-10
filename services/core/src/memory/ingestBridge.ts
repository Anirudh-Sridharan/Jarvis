/**
 * Ingest bridge (feature 9 → feature 3): converts integrations data into
 * memory ExperienceRecords so external life data becomes recallable.
 *
 * Deterministic and idempotent — capture dedups on content hashes, so each
 * pass simply re-reads recent windows and lets duplicates drop. No LLM here;
 * consolidation (existing scheduler) promotes these into the searchable graph.
 *
 * Converters:
 *   - calendar events (now−7d .. now+14d), re-captured when etag/times change
 *   - daily health digest (sleep / recovery / HRV) for the last 2 days
 *   - daily work digest (commits / emails) for the last 2 days
 */

import type { MemorySystem } from "@jarvis/memory";
import type { IntegrationsSystem } from "@jarvis/integrations";

export interface IngestDeps {
  memory: Pick<MemorySystem, "capture">;
  integrations: Pick<IntegrationsSystem, "calendar" | "metrics">;
  now?: () => Date;
}

export interface IngestPassResult {
  captured: number;
  duplicates: number;
}

const DAY_MS = 86_400_000;

export async function runIngestPass(deps: IngestDeps): Promise<IngestPassResult> {
  const now = deps.now?.() ?? new Date();
  let captured = 0;
  let duplicates = 0;

  const tally = (inserted: boolean) => {
    if (inserted) captured++;
    else duplicates++;
  };

  // ── Calendar events ──
  const from = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const to = new Date(now.getTime() + 14 * DAY_MS).toISOString();
  for (const e of deps.integrations.calendar.mirror.getEvents("primary", from, to)) {
    const start = e.start.dateTime ?? e.start.date ?? "";
    const end = e.end.dateTime ?? e.end.date ?? "";
    const attendees = e.attendees
      .filter((a) => !a.self && a.email)
      .map((a) => a.displayName ?? a.email);
    const parts = [
      `Calendar event: ${e.summary || "(untitled)"} — ${start}..${end}`,
      e.location ? `at ${e.location}` : "",
      attendees.length > 0 ? `with ${attendees.join(", ")}` : "",
    ].filter(Boolean);

    const result = await deps.memory.capture.captureExternal({
      source: "gcal",
      type: "calendar_event",
      nativeId: e.id,
      text: parts.join(", "),
      timestamp: start || e.updated,
      payload: { calendarId: e.calendarId, eventId: e.id, status: e.status },
      entities: attendees.map((a) => ({ kind: "person" as const, value: a })),
      // etag/times change → re-capture the moved/edited event
      content: { etag: e.etag, start, end, summary: e.summary, status: e.status },
    });
    tally(result.inserted);
  }

  // ── Daily digests for yesterday and today ──
  for (const dayOffset of [1, 0]) {
    const day = new Date(now.getTime() - dayOffset * DAY_MS).toISOString().slice(0, 10);
    const range = { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` };

    // Health: sleep / recovery / HRV
    const healthParts: string[] = [];
    const sleep = sumPoints(deps.integrations, "sleep.duration_min", range);
    if (sleep != null) healthParts.push(`slept ${(sleep / 60).toFixed(1)}h`);
    const recovery = avgPoints(deps.integrations, "recovery", range);
    if (recovery != null) healthParts.push(`recovery ${Math.round(recovery)}%`);
    const hrv = avgPoints(deps.integrations, "hrv", range);
    if (hrv != null) healthParts.push(`HRV ${Math.round(hrv)}ms`);

    if (healthParts.length > 0) {
      const text = `Health ${day}: ${healthParts.join("; ")}`;
      const result = await deps.memory.capture.captureExternal({
        source: "whoop",
        type: "health_metric",
        nativeId: `health-digest-${day}`,
        text,
        timestamp: `${day}T12:00:00Z`,
        payload: { day, sleepMin: sleep, recovery, hrv },
        content: text,
      });
      tally(result.inserted);
    }

    // Work: commits + email volume
    const commits = sumPoints(deps.integrations, "github.commits", range);
    const received = sumPoints(deps.integrations, "gmail.received", range);
    const sent = sumPoints(deps.integrations, "gmail.sent", range);
    const workParts: string[] = [];
    if (commits) workParts.push(`${commits} commits`);
    if (received || sent) workParts.push(`${received ?? 0} emails received, ${sent ?? 0} sent`);

    if (workParts.length > 0) {
      const text = `Work activity ${day}: ${workParts.join("; ")}`;
      const result = await deps.memory.capture.captureExternal({
        source: "github",
        type: "code_activity",
        nativeId: `work-digest-${day}`,
        text,
        timestamp: `${day}T12:00:00Z`,
        payload: { day, commits, emailsReceived: received, emailsSent: sent },
        content: text,
      });
      tally(result.inserted);
    }
  }

  return { captured, duplicates };
}

function sumPoints(
  integrations: Pick<IntegrationsSystem, "metrics">,
  metric: string,
  range: { from: string; to: string },
): number | null {
  const series = integrations.metrics.querySeries(metric, range);
  if (series.points.length === 0) return null;
  return series.points.reduce((acc, p) => acc + p.value, 0);
}

function avgPoints(
  integrations: Pick<IntegrationsSystem, "metrics">,
  metric: string,
  range: { from: string; to: string },
): number | null {
  const series = integrations.metrics.querySeries(metric, range);
  if (series.points.length === 0) return null;
  return series.points.reduce((acc, p) => acc + p.value, 0) / series.points.length;
}

// ── Periodic runner (live server) ─────────────────────────────────────────────

const INGEST_INTERVAL_MS = 30 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/** Start the periodic bridge: one immediate pass, then every 30 min. Idempotent. */
export function startIngestBridge(deps: IngestDeps): void {
  if (timer) return;
  const pass = () =>
    runIngestPass(deps)
      .then((r) => {
        if (r.captured > 0) {
          console.error(`[ingest] captured ${r.captured} external records (${r.duplicates} dups)`);
        }
      })
      .catch((err) => {
        console.warn("[ingest] pass failed:", err instanceof Error ? err.message : String(err));
      });
  void pass();
  timer = setInterval(pass, INGEST_INTERVAL_MS);
  timer.unref();
}

export function stopIngestBridge(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
