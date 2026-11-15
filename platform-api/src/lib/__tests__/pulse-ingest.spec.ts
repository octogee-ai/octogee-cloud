import { describe, it, expect, vi } from "vitest";
import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import type { RepositoryActivityApi } from "../repository-activity.js";
import { fetchPulseReport, weekRanges } from "../pulse-ingest.js";

describe("weekRanges", () => {
  it("returns rolling 7-day windows, most-recent first, as YYYY-MM-DD", () => {
    const now = Date.parse("2026-06-26T12:00:00Z");
    expect(weekRanges(now, 2)).toEqual([
      { since: "2026-06-19", until: "2026-06-26" },
      { since: "2026-06-12", until: "2026-06-19" },
    ]);
  });

  it("chains windows so each since is the prior until", () => {
    const r = weekRanges(Date.parse("2026-06-26T00:00:00Z"), 4);
    expect(r).toHaveLength(4);
    for (let i = 1; i < r.length; i += 1) expect(r[i].until).toBe(r[i - 1].since);
  });
});

describe("fetchPulseReport", () => {
  it("scores provider-neutral repository activity without reading provider fields", async () => {
    const ranges = weekRanges(Date.parse("2026-06-26T12:00:00Z"), 2);
    const currentPr = {
      number: 2,
      title: "feat: launch",
      createdAt: "2026-06-20T00:00:00Z",
      mergedAt: "2026-06-21T00:00:00Z",
      url: "https://git.example/pulls/2",
      additions: 10,
      deletions: 2,
    };
    const activity: RepositoryActivityApi = {
      mergedPullRequests: vi.fn(async (range) => range.since === ranges[0].since ? [currentPr] : []),
      commits: vi.fn(async (range) => range.since === ranges[0].since
        ? [
            {
              subject: "Revert broken launch",
              committedAt: "2026-06-22T00:00:00Z",
              url: "https://git.example/commit/revert",
            },
          ]
        : []),
      issues: vi.fn(async (range) => range.since === ranges[0].since
        ? [
            {
              number: 3,
              title: "Launch regression",
              body: "",
              state: "closed" as const,
              labels: ["bug"],
              assignees: [],
              author: "builder",
              createdAt: "2026-06-20T00:00:00Z",
              closedAt: "2026-06-23T00:00:00Z",
              updatedAt: "2026-06-23T00:00:00Z",
              url: "https://git.example/issues/3",
            },
          ]
        : []),
      openPullRequests: vi.fn(async () => []),
      openIssues: vi.fn(async () => []),
    };
    const target = {
      slug: "acme",
      projectSlug: "rocket",
      provider: "gitea",
      org: "acme",
      repoName: "acme-rocket",
      gcsPrefix: "customers/acme/projects/rocket",
      sudoUser: "ws-acme",
    } as FileTarget;

    const report = await fetchPulseReport(target, Date.parse("2026-06-26T12:00:00Z"), 2, activity);

    expect(report.current.speed).toMatchObject({ prsMerged: 1, commits: 1, leadTimeMedianHours: 24 });
    expect(report.current.quality.reverts).toBe(1);
    expect(report.current.impact).toMatchObject({ feat: 1, issuesOpened: 1, issuesClosed: 1 });
    expect(report.bugs).toEqual({ openedThisWeek: 1, closedThisWeek: 1, openNow: 0 });
    expect(activity.issues).toHaveBeenCalledTimes(2);
  });
});
