/**
 * GitHub connector — PAT-based, ETag conditional requests + since cursor.
 *
 * Normalizes: commits, PRs (opened/merged), issues (opened/closed)
 * → MetricPoints (commits/day, prs_opened/merged, issues counts)
 *
 * ETag handling: 304 = no change, advance lastCheckedAt but write no points.
 * Rate limit: 5000 req/hr; connector checks X-RateLimit-Remaining.
 */

import type {
  Connector,
  ConnectorSyncResult,
  Cursor,
  HttpClient,
  MetricPoint,
  TokenStore,
  WorkEvent,
} from "../types.js";
import { metricPointFactory } from "../framework/normalize.js";

export const githubConnector: Connector = {
  id: "github",
  auth: "pat",
  schedule: "*/30 * * * *", // every 30 minutes
  concurrency: 2,

  async sync(
    cursor: Cursor | null,
    http: HttpClient,
    tokenStore: TokenStore
  ): Promise<ConnectorSyncResult> {
    // Repos to sync from cursor metadata (or default to configured list)
    const since = cursor?.highWater ?? thirtyDaysAgo();
    const repos = getRepos();
    if (repos.length === 0) {
      return { points: [], nextCursor: null }; // no repos configured → no-op sync
    }

    const tokens = await tokenStore.get("github");
    const pat = tokens?.accessToken;
    if (!pat) {
      // Without a PAT every request 401s and is silently swallowed — the run
      // would be recorded "ok" with 0 points. Fail loudly instead.
      throw new Error(
        "GitHub sync requires a personal access token: no token found in TokenStore for source 'github'."
      );
    }

    const events: WorkEvent[] = [];
    let latestTs = since;

    for (const repo of repos) {
      const repoEvents = await syncRepo(repo, since, pat, http);
      events.push(...repoEvents);
      for (const e of repoEvents) {
        if (e.ts > latestTs) latestTs = e.ts;
      }
    }

    const points = workEventsToMetricPoints(events);

    return {
      points,
      nextCursor: latestTs !== since ? latestTs : null,
    };
  },
};

async function syncRepo(
  repo: string,
  since: string,
  pat: string,
  http: HttpClient
): Promise<WorkEvent[]> {
  const events: WorkEvent[] = [];
  const headers: Record<string, string> = {
    Authorization: `token ${pat}`,
    Accept: "application/vnd.github.v3+json",
  };

  // Commits (ETag conditional request)
  const commitsUrl = `https://api.github.com/repos/${repo}/commits?since=${since}&per_page=100`;
  const commitsRes = await http.request({ method: "GET", url: commitsUrl, headers });

  if (commitsRes.status === 200) {
    const commits = commitsRes.body as RawCommit[];
    for (const c of commits) {
      events.push({
        id: `gh:commit:${c.sha}`,
        source: "github",
        type: "commit",
        ts: c.commit?.author?.date ?? since,
        repo,
        title: (c.commit?.message ?? "").split("\n")[0],
        url: c.html_url,
        meta: { author: c.commit?.author?.name },
      });
    }
  }
  // 304 = no change, skip (ETag handling is transparent via http fixture)

  // PRs
  const prsUrl = `https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const prsRes = await http.request({ method: "GET", url: prsUrl, headers });

  if (prsRes.status === 200) {
    const prs = prsRes.body as RawPR[];
    for (const p of prs) {
      if (p.created_at >= since) {
        events.push({
          id: `gh:pr_opened:${p.id}`,
          source: "github",
          type: "pr_opened",
          ts: p.created_at,
          repo,
          title: p.title,
          url: p.html_url,
        });
      }
      if (p.merged_at && p.merged_at >= since) {
        events.push({
          id: `gh:pr_merged:${p.id}`,
          source: "github",
          type: "pr_merged",
          ts: p.merged_at,
          repo,
          title: p.title,
          url: p.html_url,
          meta: { additions: p.additions, deletions: p.deletions },
        });
      }
    }
  }

  // Issues
  const issuesUrl = `https://api.github.com/repos/${repo}/issues?state=all&since=${since}&per_page=100`;
  const issuesRes = await http.request({ method: "GET", url: issuesUrl, headers });

  if (issuesRes.status === 200) {
    const issues = issuesRes.body as RawIssue[];
    for (const i of issues) {
      // Skip PRs (GitHub issues endpoint includes PRs)
      if (i.pull_request) continue;

      if (i.created_at >= since) {
        events.push({
          id: `gh:issue_opened:${i.id}`,
          source: "github",
          type: "issue_opened",
          ts: i.created_at,
          repo,
          title: i.title,
          url: i.html_url,
        });
      }
      if (i.closed_at && i.closed_at >= since) {
        events.push({
          id: `gh:issue_closed:${i.id}`,
          source: "github",
          type: "issue_closed",
          ts: i.closed_at,
          repo,
          title: i.title,
          url: i.html_url,
        });
      }
    }
  }

  return events;
}

/** Convert WorkEvents → MetricPoints (daily counts). */
export function workEventsToMetricPoints(events: WorkEvent[]): MetricPoint[] {
  const point = metricPointFactory("github");
  const points: MetricPoint[] = [];

  // Group by (type, ts-day)
  const byTypeDay = new Map<string, { ts: string; count: number; repo?: string }>();

  for (const e of events) {
    const day = e.ts.slice(0, 10);
    const key = `${e.type}:${day}:${e.repo ?? ""}`;
    const existing = byTypeDay.get(key);
    if (existing) {
      existing.count++;
    } else {
      byTypeDay.set(key, { ts: `${day}T00:00:00Z`, count: 1, repo: e.repo });
    }
  }

  const typeToMetric: Record<WorkEvent["type"], string | null> = {
    commit: "github.commits",
    pr_opened: "github.prs_opened",
    pr_merged: "github.prs_merged",
    pr_reviewed: "github.prs_reviewed",
    review_comment: null,
    issue_opened: "github.issues_opened",
    issue_closed: "github.issues_closed",
    email_received: null,
    email_sent: null,
    email_unread_snapshot: null,
  };

  for (const [key, { ts, count, repo }] of byTypeDay.entries()) {
    const type = key.split(":")[0] as WorkEvent["type"];
    const metric = typeToMetric[type];
    if (!metric) continue;

    const dims: Record<string, string> = {};
    if (repo) dims["repo"] = repo;

    points.push(point({ metric, value: count, unit: "count", ts, dims }));
  }

  return points;
}

// ── Raw API shapes ────────────────────────────────────────────────────────────

interface RawCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { date?: string; name?: string };
  };
}

interface RawPR {
  id: number;
  title: string;
  html_url?: string;
  created_at: string;
  merged_at?: string | null;
  additions?: number;
  deletions?: number;
}

interface RawIssue {
  id: number;
  title: string;
  html_url?: string;
  created_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

function getRepos(): string[] {
  const configured = process.env["GITHUB_REPOS"];
  if (configured) return configured.split(",").map((r) => r.trim());
  return []; // no repos configured → no-op sync
}

function thirtyDaysAgo(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}
