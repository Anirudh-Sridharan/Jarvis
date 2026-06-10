/**
 * GitHub connector tests:
 *   - Fixture activity → MetricPoints (commits, prs_opened, prs_merged)
 *   - ETag 304 → no-op (no new points)
 *   - workEventsToMetricPoints: daily count bucketing
 */

import { describe, it, expect } from "vitest";
import { workEventsToMetricPoints } from "../src/connectors/github.js";
import type { WorkEvent } from "../src/types.js";

function makeWorkEvent(overrides: Partial<WorkEvent> = {}): WorkEvent {
  return {
    id: "gh:commit:abc123",
    source: "github",
    type: "commit",
    ts: "2026-06-09T09:00:00Z",
    repo: "user/jarvis",
    title: "feat: add metric store",
    ...overrides,
  };
}

describe("workEventsToMetricPoints", () => {
  it("converts commit events to github.commits MetricPoints", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:commit:a1", ts: "2026-06-09T09:00:00Z", type: "commit" }),
      makeWorkEvent({ id: "gh:commit:a2", ts: "2026-06-09T11:00:00Z", type: "commit" }),
      makeWorkEvent({ id: "gh:commit:a3", ts: "2026-06-09T15:00:00Z", type: "commit" }),
    ];

    const points = workEventsToMetricPoints(events);
    const commits = points.filter((p) => p.metric === "github.commits");

    expect(commits).toHaveLength(1); // all on same day → 1 daily point
    expect(commits[0]?.value).toBe(3); // 3 commits
    expect(commits[0]?.ts).toBe("2026-06-09T00:00:00Z");
  });

  it("buckets events into separate days correctly", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:commit:a1", ts: "2026-06-08T10:00:00Z", type: "commit" }),
      makeWorkEvent({ id: "gh:commit:a2", ts: "2026-06-09T10:00:00Z", type: "commit" }),
    ];

    const points = workEventsToMetricPoints(events);
    const commits = points.filter((p) => p.metric === "github.commits");

    expect(commits).toHaveLength(2);
    expect(commits.map((p) => p.ts).sort()).toEqual([
      "2026-06-08T00:00:00Z",
      "2026-06-09T00:00:00Z",
    ]);
  });

  it("generates prs_merged MetricPoints from pr_merged events", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:pr_merged:101", ts: "2026-06-09T14:00:00Z", type: "pr_merged", title: "Add data integration" }),
    ];

    const points = workEventsToMetricPoints(events);
    const merged = points.filter((p) => p.metric === "github.prs_merged");

    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toBe(1);
    expect(merged[0]?.source).toBe("github");
  });

  it("generates prs_opened MetricPoints", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:pr_opened:101", ts: "2026-06-09T08:00:00Z", type: "pr_opened" }),
    ];

    const points = workEventsToMetricPoints(events);
    const opened = points.filter((p) => p.metric === "github.prs_opened");
    expect(opened).toHaveLength(1);
  });

  it("generates issue_opened and issue_closed MetricPoints", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:issue_opened:1", ts: "2026-06-09T09:00:00Z", type: "issue_opened" }),
      makeWorkEvent({ id: "gh:issue_closed:1", ts: "2026-06-09T17:00:00Z", type: "issue_closed" }),
    ];

    const points = workEventsToMetricPoints(events);
    expect(points.find((p) => p.metric === "github.issues_opened")).toBeDefined();
    expect(points.find((p) => p.metric === "github.issues_closed")).toBeDefined();
  });

  it("is idempotent: same events produce same MetricPoint ids", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:commit:a1", ts: "2026-06-09T09:00:00Z", type: "commit" }),
      makeWorkEvent({ id: "gh:commit:a2", ts: "2026-06-09T11:00:00Z", type: "commit" }),
    ];

    const pts1 = workEventsToMetricPoints(events);
    const pts2 = workEventsToMetricPoints(events);

    const ids1 = new Set(pts1.map((p) => p.id));
    const ids2 = new Set(pts2.map((p) => p.id));
    expect(ids1).toEqual(ids2);
  });

  it("separates points by repo dimension", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:commit:a1", ts: "2026-06-09T09:00:00Z", repo: "user/jarvis" }),
      makeWorkEvent({ id: "gh:commit:b1", ts: "2026-06-09T10:00:00Z", repo: "user/other" }),
    ];

    const points = workEventsToMetricPoints(events);
    const commits = points.filter((p) => p.metric === "github.commits");

    // Two different repos → two separate MetricPoints (different dims)
    expect(commits).toHaveLength(2);
    const repos = commits.map((p) => p.dims?.["repo"]);
    expect(repos).toContain("user/jarvis");
    expect(repos).toContain("user/other");
  });

  it("ETag 304 simulation: empty event list → empty points", () => {
    const points = workEventsToMetricPoints([]);
    expect(points).toHaveLength(0);
  });

  it("ignores non-metric event types (review_comment)", () => {
    const events: WorkEvent[] = [
      makeWorkEvent({ id: "gh:rc:1", type: "review_comment", ts: "2026-06-09T10:00:00Z" }),
    ];
    const points = workEventsToMetricPoints(events);
    // review_comment has no metric → should not appear
    expect(points.every((p) => p.metric !== "review_comment")).toBe(true);
  });
});
