import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import {
  createRepositoryActivityApi,
  type RepositoryActivityApi,
  type RepositoryActivityRange,
  type RepositoryPullRequest,
} from "./repository-activity.js";
import type { WorkspaceIssue } from "./issues-normalize.js";
import {
  computeDxCore4,
  isRevert,
  type DxCore4,
  type PulsePr,
  type PulseWindow,
  type RevertCommit,
} from "./pulse-metrics.js";

const DAY_MS = 86_400_000;
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export type WeekRange = RepositoryActivityRange;

export function weekRanges(nowMs: number, weeks: number): WeekRange[] {
  const out: WeekRange[] = [];
  for (let i = 0; i < weeks; i += 1) {
    out.push({ since: ymd(nowMs - (i + 1) * 7 * DAY_MS), until: ymd(nowMs - i * 7 * DAY_MS) });
  }
  return out;
}

function timestampInRange(value: string | null, range: WeekRange): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  const since = Date.parse(`${range.since}T00:00:00Z`);
  const until = Date.parse(`${range.until}T00:00:00Z`);
  return Number.isFinite(timestamp) && timestamp >= since && timestamp < until;
}

function pulsePr(pr: RepositoryPullRequest): PulsePr {
  return {
    title: pr.title,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt ?? "",
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

async function fetchWindow(
  activity: RepositoryActivityApi,
  range: WeekRange,
): Promise<{ window: PulseWindow; issues: WorkspaceIssue[] }> {
  const [merged, commits, issues] = await Promise.all([
    activity.mergedPullRequests(range),
    activity.commits(range),
    activity.issues(range),
  ]);
  const revertCommits: RevertCommit[] = commits
    .filter((commit) => isRevert(commit.subject))
    .map((commit) => ({ subject: commit.subject, url: commit.url }));
  return {
    window: {
      prs: merged.map(pulsePr),
      commits: commits.length,
      revertCommits,
      issuesClosed: issues.filter((issue) => timestampInRange(issue.closedAt, range)).length,
      issuesOpened: issues.filter((issue) => timestampInRange(issue.createdAt, range)).length,
    },
    issues,
  };
}

export async function fetchPulseWindow(
  target: FileTarget,
  since: string,
  until: string,
): Promise<PulseWindow> {
  return (await fetchWindow(createRepositoryActivityApi(target), { since, until })).window;
}

export interface StalePr {
  number: number;
  title: string;
  url: string;
  days: number;
}

export interface BugBacklog {
  openedThisWeek: number;
  closedThisWeek: number;
  openNow: number;
}

export interface PulseReport {
  current: DxCore4;
  previous: DxCore4;
  trendPrs: number[];
  week: WeekRange;
  reverts: RevertCommit[];
  stalePrs: StalePr[];
  bugs: BugBacklog;
}

const STALE_DAYS = 7;

async function fetchStalePrs(activity: RepositoryActivityApi, nowMs: number): Promise<StalePr[]> {
  const items = await activity.openPullRequests();
  return items
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      days: Math.floor((nowMs - Date.parse(pr.createdAt)) / DAY_MS),
    }))
    .filter((p) => Number.isFinite(p.days) && p.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days);
}

async function fetchBugBacklog(
  activity: RepositoryActivityApi,
  range: WeekRange,
  events: WorkspaceIssue[],
): Promise<BugBacklog> {
  const open = await activity.openIssues(["bug"]);
  const bugs = events.filter((issue) => issue.labels.includes("bug"));
  return {
    openedThisWeek: bugs.filter((issue) => timestampInRange(issue.createdAt, range)).length,
    closedThisWeek: bugs.filter((issue) => timestampInRange(issue.closedAt, range)).length,
    openNow: open.length,
  };
}

export async function fetchPulseReport(
  target: FileTarget,
  nowMs: number,
  trendWeeks = 6,
  activity: RepositoryActivityApi = createRepositoryActivityApi(target),
): Promise<PulseReport> {
  const ranges = weekRanges(nowMs, Math.max(2, trendWeeks));
  const [currentActivity, previousActivity] = await Promise.all([
    fetchWindow(activity, ranges[0]),
    fetchWindow(activity, ranges[1]),
  ]);
  const curWin = currentActivity.window;
  const prevWin = previousActivity.window;
  const current = computeDxCore4(curWin);
  const previous = computeDxCore4(prevWin);
  const counts = [current.speed.prsMerged, previous.speed.prsMerged];
  for (let i = 2; i < trendWeeks; i += 1) {
    counts.push((await activity.mergedPullRequests(ranges[i])).length);
  }
  const [stalePrs, bugs] = await Promise.all([
    fetchStalePrs(activity, nowMs),
    fetchBugBacklog(activity, ranges[0], currentActivity.issues),
  ]);
  return {
    current,
    previous,
    trendPrs: counts.reverse(),
    week: ranges[0],
    reverts: curWin.revertCommits,
    stalePrs,
    bugs,
  };
}
