# Work & Productivity Metrics
> Priority/build order: 13  ·  Tier: deep

## Summary

This feature models everything Jarvis knows about **how you work**: what you ship (GitHub commits, PRs, issues, reviews), how your inbox flows (Gmail volume, unread, response time, follow-ups owed), and what you still owe yourself (a **built-in to-do list** that Jarvis owns natively). It exists because the user runs **no external task tool** (no Notion / Linear / Jira), so Jarvis must both *measure* productivity and *be* the task list.

v1 has exactly two external work sources, both pulled through the shared connector framework (feature 9): **GitHub** (Personal Access Token) and **Gmail** (OAuth). A deterministic ETL normalizes raw API payloads into a single `WorkEvent` stream, then folds events into time-bucketed `MetricSeries` (commits/day, PRs opened/merged, review activity, email volume, response time, follow-ups). A separate **Todo store** is plain local CRUD — no third-party sync — exposed as a small API consumed by *both* the dashboard UI (feature 14) and the agent's reminders/skills (feature 18). Optional local **ActivityWatch** focus-time ingestion is designed-for but not built in v1.

Outputs feed the metrics dashboard (14, the "Work" section + a Todo widget), the daily briefing (15, "what you shipped yesterday / follow-ups owed / overdue todos"), and memory context (3, so the agent can answer "what was I working on last Tuesday?"). Everything is local-first, free/OSS, TypeScript/Node, sized for an M3 Air 16GB.

## Data flow  *(REQUIRED)*

**Inputs**
- GitHub via feature 9 connector (`github`): commits, PRs, issues, reviews, review comments. Auth = PAT, 5000 req/hr. Quota saved with **ETag** (conditional requests → 304) and `since` cursors.
- Gmail via feature 9 connector (`gmail`): message/thread metadata only (volume, unread, label state, internalDate, in-reply-to). Auth = OAuth. We do **not** act on email here — agent email actions live in feature 18.
- Built-in **Todo store**: local SQLite table, written by user (UI) and agent (18).
- (Later) ActivityWatch local REST (`http://localhost:5600`) for focus/AFK buckets.

**Numbered pipeline**
1. **Schedule** — feature 19 trigger fires the `work.sync` job (default every 30 min; configurable). Briefing pre-warm at 06:30 local.
2. **Fetch (GitHub)** — connector calls REST/GraphQL with stored ETag + `sinceCursor` per resource per repo. 304 → skip, refresh `lastCheckedAt` only. 200 → new/changed items.
3. **Fetch (Gmail)** — `users.messages.list` with `historyId` (incremental) when available, else `q="newer_than:Nd"`; hydrate metadata via `messages.get?format=metadata`.
4. **Normalize** — map each raw item to a `WorkEvent` (deterministic, idempotent on `id`). GitHub event types: `commit | pr_opened | pr_merged | pr_reviewed | review_comment | issue_opened | issue_closed`. Gmail: `email_received | email_sent | email_unread_snapshot`.
5. **Persist events** — upsert into `work_events` keyed by stable `id` (dedup across overlapping `since` windows).
6. **Bucket / aggregate** — fold `work_events` into `MetricSeries` per metric per **day** (user timezone), e.g. `commits/day`, `prs_merged/day`, `email_received/day`, `response_time_p50`.
7. **Derive follow-ups** — sent threads with no reply after N days → `followups_owed` count; surfaced in briefing.
8. **Todos** — independent CRUD path; `overdue()` computed at read time from `due < now && status==='open'`.
9. **Publish** — write `MetricSeries` to the metrics store (shared with 14), emit a memory note to feature 3 ("shipped" summary), expose Todo API.
10. **Status** — record per-source sync health (`ok | partial | error`, `lastError`, `rateRemaining`) for the UI error/empty states.

**Outputs**
- Work `MetricSeries[]` (consumed by dashboard 14 + briefing 15).
- `WorkEvent[]` (raw-ish normalized log; powers "what you shipped" lists + memory 3).
- `Todo[]` via Todo API (dashboard widget + agent 18 + briefing overdue list).

**Schemas** — see [Logic / rules](#logic--rules) for `WorkEvent`, `MetricSeries`, `Todo`.

### Mermaid

```mermaid
flowchart TD
  subgraph EXT[External sources]
    GH[GitHub REST/GraphQL\nPAT 5000/hr + ETag/since]
    GM[Gmail API\nOAuth · metadata only]
    AW[ActivityWatch\nlocal REST · later]
  end
  subgraph F9[Feature 9 connector framework]
    CGH[github connector]
    CGM[gmail connector]
  end
  GH --> CGH --> NORM
  GM --> CGM --> NORM
  AW -. later .-> NORM
  NORM[Deterministic normalizer\nraw -> WorkEvent] --> WE[(work_events)]
  WE --> AGG[Bucket / aggregate\nper day, user TZ] --> MS[(MetricSeries store)]
  WE --> SHIP[\"what you shipped\" list]
  MS --> DASH[Dashboard 14 · Work section]
  MS --> BRIEF[Briefing 15]
  WE --> MEM[Memory 3]
  subgraph TODO[Built-in Todo store · local SQLite]
    TS[(todos)]
    API[Todo API\naddTodo / completeTodo / overdue]
  end
  TS --> API
  API <--> UI[Todo List UI · feature 14]
  API <--> AG[Agent reminders/skills · feature 18]
  API --> BRIEF
  SCH[Feature 19 trigger\nwork.sync] --> CGH
  SCH --> CGM
```

## Frontend flow  *(REQUIRED)*

The dashboard (feature 14) renders a **Work** section plus an embedded **Todo List** widget. This feature supplies the data contracts and the Todo API; 14 owns layout/theming.

**Work section**
- **Shipped strip** — small multiples / sparkline of `commits/day`, `prs_merged/day`, `issues_closed/day` over the selected range (7d default). A "What you shipped" list expands to the underlying `WorkEvent`s (PR titles, merged repos) for the period.
- **Activity chart** — stacked bars per day: commits / PRs / reviews. Hover → tooltip with exact counts; click a bar → that day's event list.
- **Email triage counts** — three stat tiles: `Unread`, `Awaiting reply (follow-ups owed)`, `Median response time`. Tiles link to a read-only thread summary (subjects + ages); no inbox actions here.

**Todo List UI** (CRUD)
- **Add**: inline input → `addTodo({ text, due?, source:'user' })`; optimistic insert.
- **Complete**: checkbox → `completeTodo(id)`; strikethrough + moves to "Done today" group.
- **Snooze**: snooze control sets `due = now + {1d|tomorrow|next week}` and keeps status `open` (records `snoozedCount`).
- **Overdue**: items where `overdue()` is true rendered with a red pill, sorted to top.
- **Agent-created todos**: `source:'agent'` items show a small bot badge + the `links` (e.g. originating email thread / PR).

**States**
- **Empty** — no connector configured: Work section shows a "Connect GitHub / Gmail" CTA (deep-links to feature 9 settings). Empty Todo list shows "No todos — add one or ask Jarvis."
- **Loading** — skeleton sparklines + skeleton rows; metrics served from last-good cache while refreshing (stale-while-revalidate, with `asOf` timestamp).
- **Error** — per-source banner ("GitHub sync failed: rate limited, retrying 14:05"); other source's data still renders. Todo CRUD is local and stays usable even when external syncs fail.
- **Partial** — e.g. Gmail OK, GitHub 304-only: show data, mark `asOf` per source.

## Logic / rules  *(deep tier)*

**Schemas**

```ts
// One normalized unit of "work that happened".
export interface WorkEvent {
  id: string;                 // stable, source-derived (dedup key)
  source: 'github' | 'gmail';
  type:
    | 'commit' | 'pr_opened' | 'pr_merged' | 'pr_reviewed'
    | 'review_comment' | 'issue_opened' | 'issue_closed'
    | 'email_received' | 'email_sent' | 'email_unread_snapshot';
  ts: string;                 // ISO 8601 UTC (event time)
  repo?: string;              // owner/name  (github)
  title?: string;             // PR/issue/commit subject, email subject
  url?: string;               // permalink / gmail thread link
  thread?: string;            // gmail threadId
  meta?: Record<string, unknown>; // additions, deletions, labels, etc.
}

export interface MetricPoint { t: string; v: number; } // t = YYYY-MM-DD (user TZ)

export interface MetricSeries {
  key: string;                // 'commits' | 'prs_merged' | 'email_received' | 'response_time_p50' ...
  unit: 'count' | 'ms' | 'minutes';
  bucket: 'day';
  source: 'github' | 'gmail' | 'todo' | 'derived';
  points: MetricPoint[];
  asOf: string;               // last successful sync (ISO)
}

export interface Todo {
  id: string;
  text: string;
  due?: string;               // ISO; absent = no due date
  status: 'open' | 'done';
  source: 'user' | 'agent';   // who created it
  links?: { type: 'github' | 'gmail' | 'note'; url: string }[];
  createdAt: string;
  completedAt?: string;
  recurrence?: 'daily' | 'weekly' | 'weekdays' | null;
  snoozedCount?: number;
}
```

**Snippet 1 — GitHub activity normalizer (ETag + `since` → MetricPoints)**

```ts
import type { WorkEvent } from './schemas';
import { gh } from '../9-connectors/github'; // shared connector: returns {status, etag, data}

interface RepoCursor { etag?: string; since?: string; } // since = ISO of last seen item

// Fetch + normalize one repo's recent activity. Deterministic + idempotent.
export async function syncRepoActivity(
  repo: string,
  cursor: RepoCursor,
): Promise<{ events: WorkEvent[]; cursor: RepoCursor }> {
  const events: WorkEvent[] = [];

  // Conditional request: 304 => nothing changed, spend ~0 quota.
  const commits = await gh.get(`/repos/${repo}/commits`, {
    etag: cursor.etag,
    query: cursor.since ? { since: cursor.since } : undefined,
  });
  if (commits.status === 304) return { events, cursor }; // unchanged

  for (const c of commits.data) {
    events.push({
      id: `gh:commit:${c.sha}`,
      source: 'github',
      type: 'commit',
      ts: c.commit.author.date,
      repo,
      title: c.commit.message.split('\n')[0],
      url: c.html_url,
      meta: { author: c.commit.author.name },
    });
  }

  // PRs (state changes drive pr_opened / pr_merged)
  const prs = await gh.get(`/repos/${repo}/pulls`, {
    query: { state: 'all', sort: 'updated', direction: 'desc' },
  });
  for (const p of prs.data) {
    events.push({
      id: `gh:pr_opened:${p.id}`, source: 'github', type: 'pr_opened',
      ts: p.created_at, repo, title: p.title, url: p.html_url,
    });
    if (p.merged_at) {
      events.push({
        id: `gh:pr_merged:${p.id}`, source: 'github', type: 'pr_merged',
        ts: p.merged_at, repo, title: p.title, url: p.html_url,
        meta: { additions: p.additions, deletions: p.deletions },
      });
    }
  }

  const newest = events.reduce<string | undefined>(
    (m, e) => (!m || e.ts > m ? e.ts : m), cursor.since);
  return { events, cursor: { etag: commits.etag, since: newest } };
}

// Fold events into a daily count series, bucketed by USER timezone.
export function toDailySeries(
  events: WorkEvent[], type: WorkEvent['type'], key: string, tz: string,
): MetricPoint[] {
  const byDay = new Map<string, number>();
  for (const e of events) {
    if (e.type !== type) continue;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(e.ts)); // YYYY-MM-DD
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay.entries()].sort().map(([t, v]) => ({ t, v }));
}
```

**Snippet 2 — Built-in Todo store (CRUD used by UI *and* agent)**

```ts
import { randomUUID } from 'node:crypto';
import { db } from '../db'; // shared SQLite handle
import type { Todo } from './schemas';

export interface NewTodo {
  text: string;
  due?: string;
  source: 'user' | 'agent';
  links?: Todo['links'];
  recurrence?: Todo['recurrence'];
}

export function addTodo(input: NewTodo): Todo {
  const todo: Todo = {
    id: randomUUID(),
    text: input.text.trim(),
    due: input.due,
    status: 'open',
    source: input.source,
    links: input.links ?? [],
    recurrence: input.recurrence ?? null,
    snoozedCount: 0,
    createdAt: new Date().toISOString(),
  };
  if (!todo.text) throw new Error('todo text required');
  db.prepare(
    `INSERT INTO todos (id,text,due,status,source,links,recurrence,snoozedCount,createdAt)
     VALUES (@id,@text,@due,@status,@source,@links,@recurrence,@snoozedCount,@createdAt)`
  ).run({ ...todo, links: JSON.stringify(todo.links) });
  return todo;
}

export function completeTodo(id: string): Todo {
  const now = new Date().toISOString();
  const row = getTodo(id);
  if (!row) throw new Error(`no todo ${id}`);
  db.prepare(`UPDATE todos SET status='done', completedAt=? WHERE id=?`).run(now, id);

  // Recurring todos respawn the next instance on completion.
  if (row.recurrence) {
    addTodo({
      text: row.text, source: row.source, links: row.links,
      recurrence: row.recurrence, due: nextDue(row.due, row.recurrence),
    });
  }
  return { ...row, status: 'done', completedAt: now };
}

// Read-time overdue computation (no stale flag to maintain).
export function overdue(now = new Date()): Todo[] {
  const rows = db.prepare(
    `SELECT * FROM todos WHERE status='open' AND due IS NOT NULL AND due < ?`
  ).all(now.toISOString());
  return rows.map(hydrate);
}
```

**Aggregation & derived rules**
- **Daily buckets** use the user's IANA timezone (settings) so a 23:30 commit lands on the right local day.
- **Response time** = for each inbound thread the user replied to, `sent.ts − received.ts`; report p50 and p90 per day; never block on threads with no reply (those are follow-ups, not response time).
- **Follow-ups owed** = `email_sent` events whose `thread` has no later `email_received` after `followupAfterDays` (default 3) and not closed.
- **"What you shipped"** = `pr_merged` + `issue_closed` + commit count, grouped by repo, for the briefing/digest window.
- **Idempotency**: all aggregation is a pure function of `work_events`; re-running produces identical series (safe to recompute fully on schema change).

## Edge cases & safety

| # | Case | Handling |
|---|------|----------|
| 1 | PAT missing scopes (no `repo` on private repos) | Connector marks source `partial`, surfaces "GitHub: token lacks `repo` scope" banner; public data still syncs. |
| 2 | GitHub rate limit hit (5000/hr) | Honor `X-RateLimit-Reset`; pause `work.sync`, persist `rateRemaining`, retry after reset; UI shows next-retry time. |
| 3 | ETag returns 304 | Treat as success-no-change: bump `lastCheckedAt`, spend ~0 quota, do not rebucket. |
| 4 | Large activity backfill (new repo / first run) | Page with `since` cursor in capped batches; cap initial window (e.g. 90d) with a "load more history" action; never block the UI. |
| 5 | Gmail API quota-unit exhaustion | Prefer `history.list` (cheap incremental) over full `messages.list`; metadata-only `format=metadata`; exponential backoff on 429. |
| 6 | Multi-repo (many repos) | Per-repo cursors; round-robin within quota budget; skip archived/forked repos by config. |
| 7 | Timezone in daily buckets | Bucket by user IANA TZ via `Intl`; DST handled by `Intl`; store events in UTC. |
| 8 | Todo recurrence | On `completeTodo`, spawn next instance via `nextDue()`; guard against infinite same-day respawn (next due strictly > today). |
| 9 | Todo created by agent vs user | `source` field drives UI badge + briefing phrasing; both share one store/API; agent writes go through the same validation (`addTodo`). |
| 10 | Duplicate events across overlapping `since` windows | Upsert on stable `id` (`gh:pr_merged:<id>`, `gmail:<msgId>`); dedup is free. |
| 11 | ActivityWatch absent | Focus-time series simply omitted; dashboard hides the panel; no error (optional source). |
| 12 | Clock skew / future-dated events | Clamp `ts` > now to now for bucketing; log anomaly to memory but keep series valid. |
| 13 | Connector revoked / 401 | Source → `error`, prompt re-auth (feature 9 / auth doc); Todo + other source unaffected. |
| 14 | Privacy: email bodies | Never store bodies; metadata only (subject, internalDate, labels, threadId). |
| 15 | Snooze loop | Track `snoozedCount`; after threshold, briefing nudges "snoozed N times — drop it?" |

## Dependencies  *(REQUIRED)*

- [features/9-data-integration-framework.md](9-data-integration-framework.md) — shared connector framework providing the `github` (PAT) and `gmail` (OAuth) clients, ETag/cursor storage, scheduling hooks, and sync-status surface.
- [features/3-memory-capture-and-ingestion.md](3-memory-capture-and-ingestion.md) — receives "what you shipped" summaries + WorkEvents so the agent can recall past work.
- [features/14-metrics-dashboard-ui.md](14-metrics-dashboard-ui.md) — renders the Work section + Todo widget from this feature's `MetricSeries` and Todo API.
- [features/15-daily-briefing-and-digest.md](15-daily-briefing-and-digest.md) — consumes shipped/follow-ups/overdue-todo summaries for the morning briefing.
- [features/18-task-automation-and-skills.md](18-task-automation-and-skills.md) — the reminders skill reads/writes the **same** Todo store via this feature's API; also owns real email actions.
- [features/19-proactive-scheduling-and-triggers.md](19-proactive-scheduling-and-triggers.md) — schedules the `work.sync` job and briefing pre-warm.
- [architecture/auth-and-integrations.md](../architecture/auth-and-integrations.md) — PAT/OAuth storage, scopes, refresh, and revocation handling.

## File structure  *(deep tier)*

```
src/features/work-metrics/
  index.ts                 # registers work.sync job + exports public API
  schemas.ts               # WorkEvent, MetricPoint, MetricSeries, Todo (+ zod)
  sync/
    githubActivity.ts      # syncRepoActivity, toDailySeries (Snippet 1)
    gmailActivity.ts       # message/thread metadata -> WorkEvent, response-time
    cursors.ts             # per-source/per-repo ETag + since cursor store
    activitywatch.ts       # OPTIONAL focus-time ingest (later, feature-flagged)
  normalize.ts             # raw payload -> WorkEvent (deterministic, idempotent)
  aggregate.ts             # work_events -> MetricSeries (daily buckets, TZ-aware)
  derive.ts                # follow-ups owed, "what you shipped", response p50/p90
  todo/
    store.ts               # addTodo, completeTodo, overdue (Snippet 2)
    recurrence.ts          # nextDue(), recurrence expansion
    api.ts                 # Todo API surface used by UI (14) + agent (18)
  status.ts                # per-source sync health for UI states
  __tests__/
    aggregate.test.ts      # bucketing + TZ + idempotency
    githubActivity.test.ts # ETag 304, dedup, backfill cap
    todo.test.ts           # CRUD, overdue(), recurrence respawn

src/db/migrations/
  00xx_work_events.sql     # work_events(id PK, source, type, ts, repo, title, url, thread, meta JSON)
  00xx_todos.sql           # todos(id PK, text, due, status, source, links JSON, recurrence, snoozedCount, createdAt, completedAt)
  00xx_metric_series.sql   # metric_series cache (shared w/ feature 14)
  00xx_sync_cursors.sql    # cursors(source, repo, etag, since, lastCheckedAt, status, lastError)
```
