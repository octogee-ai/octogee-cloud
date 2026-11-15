import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import { giteaApiAsUser } from "@octogee/core/git-host/gitea-client";
import { githubJson, githubRepoUrl } from "@octogee/core/git-host/github";
import { isPullRequest, normalizeIssue, type WorkspaceIssue } from "./issues-normalize.js";
import { logger } from "@octogee/core/http/logging";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface RepositoryActivityRange {
  since: string;
  until: string;
}

export interface RepositoryPullRequest {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  url: string;
  additions: number;
  deletions: number;
}

export interface RepositoryCommit {
  subject: string;
  committedAt: string;
  url: string;
}

export interface RepositoryActivityApi {
  mergedPullRequests(range: RepositoryActivityRange): Promise<RepositoryPullRequest[]>;
  commits(range: RepositoryActivityRange): Promise<RepositoryCommit[]>;
  issues(range: RepositoryActivityRange): Promise<WorkspaceIssue[]>;
  openPullRequests(): Promise<RepositoryPullRequest[]>;
  openIssues(labels?: string[]): Promise<WorkspaceIssue[]>;
}

export interface RepositoryActivityDependencies {
  githubJson: (
    method: string,
    url: string,
    token: string | undefined,
    body?: unknown,
  ) => Promise<unknown>;
  giteaApiAsUser: (
    sudoUser: string,
    org: string,
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<unknown>;
}

interface RawPullRequest {
  number?: unknown;
  title?: unknown;
  created_at?: unknown;
  closed_at?: unknown;
  merged?: unknown;
  merged_at?: unknown;
  html_url?: unknown;
  additions?: unknown;
  deletions?: unknown;
  pull_request?: {
    merged?: unknown;
    merged_at?: unknown;
  } | null;
}

interface RawCommit {
  created?: unknown;
  html_url?: unknown;
  commit?: {
    message?: unknown;
    author?: { date?: unknown } | null;
    committer?: { date?: unknown } | null;
  } | null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayStartUtc(day: string): string {
  return `${day}T00:00:00Z`;
}

function rangeBounds(range: RepositoryActivityRange): { since: number; until: number } {
  const since = Date.parse(dayStartUtc(range.since));
  const until = Date.parse(dayStartUtc(range.until));
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
    throw new Error(`Invalid repository activity range: ${range.since}..${range.until}`);
  }
  return { since, until };
}

function inRange(value: string | null, range: RepositoryActivityRange): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  const bounds = rangeBounds(range);
  return Number.isFinite(timestamp) && timestamp >= bounds.since && timestamp < bounds.until;
}

function normalizePullRequest(raw: unknown, closedAtIsMerged = false): RepositoryPullRequest {
  const value = raw as RawPullRequest;
  const meta = value.pull_request;
  const mergedAt =
    stringValue(meta?.merged_at) ||
    stringValue(value.merged_at) ||
    (closedAtIsMerged ? stringValue(value.closed_at) : "");
  return {
    number: numberValue(value.number),
    title: stringValue(value.title),
    createdAt: stringValue(value.created_at),
    mergedAt: mergedAt || null,
    url: stringValue(value.html_url),
    additions: numberValue(value.additions),
    deletions: numberValue(value.deletions),
  };
}

function isMerged(raw: unknown, closedAtIsMerged = false): boolean {
  const value = raw as RawPullRequest;
  if (closedAtIsMerged) return stringValue(value.closed_at).length > 0;
  if (value.pull_request) {
    return value.pull_request.merged === true && stringValue(value.pull_request.merged_at).length > 0;
  }
  return value.merged === true && stringValue(value.merged_at).length > 0;
}

function normalizeCommit(raw: unknown): RepositoryCommit {
  const value = raw as RawCommit;
  const message = stringValue(value.commit?.message);
  return {
    subject: message.split(/\r?\n/)[0],
    committedAt:
      stringValue(value.created) ||
      stringValue(value.commit?.committer?.date) ||
      stringValue(value.commit?.author?.date),
    url: stringValue(value.html_url),
  };
}

function requireCollection(raw: unknown, description: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid ${description} response: expected an array`);
  }
  return raw;
}

async function collectPages(
  description: string,
  load: (page: number) => Promise<unknown>,
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const raw = await load(page);
    const batch = requireCollection(raw, description);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  logger.warn(`[repository-activity] page cap hit for ${description}`);
  return items;
}

async function collectGithubSearchPages(
  description: string,
  query: string,
  token: string | undefined,
  request: RepositoryActivityDependencies["githubJson"],
): Promise<unknown[]> {
  return collectPages(description, async (page) => {
    const url =
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}` +
      `&per_page=${PAGE_SIZE}&page=${page}`;
    const raw = (await request("GET", url, token)) as { items?: unknown };
    return requireCollection(raw?.items, description);
  });
}

function githubActivityApi(
  target: FileTarget,
  request: RepositoryActivityDependencies["githubJson"],
): RepositoryActivityApi {
  const token = target.githubToken;
  const repo = `${target.org}/${target.repoName}`;

  return {
    async mergedPullRequests(range) {
      const raw = await collectGithubSearchPages(
        `${repo} merged pull requests`,
        `repo:${repo} is:pr is:merged merged:${range.since}..${range.until}`,
        token,
        request,
      );
      return raw
        .filter((item) => isMerged(item, true))
        .map((item) => normalizePullRequest(item, true))
        .filter((item) => inRange(item.mergedAt, range));
    },

    async commits(range) {
      const raw = await collectPages(`${repo} commits`, (page) =>
        request(
          "GET",
          githubRepoUrl(
            target.org,
            target.repoName,
            `/commits?since=${dayStartUtc(range.since)}&until=${dayStartUtc(range.until)}&per_page=${PAGE_SIZE}&page=${page}`,
          ),
          token,
        ));
      return raw.map(normalizeCommit).filter((item) => inRange(item.committedAt, range));
    },

    async issues(range) {
      const raw = await collectPages(`${repo} issue activity`, (page) =>
        request(
          "GET",
          githubRepoUrl(
            target.org,
            target.repoName,
            `/issues?state=all&since=${encodeURIComponent(dayStartUtc(range.since))}` +
              `&per_page=${PAGE_SIZE}&page=${page}`,
          ),
          token,
        ));
      return raw
        .filter((item) => !isPullRequest(item))
        .map(normalizeIssue)
        .filter((item) => inRange(item.createdAt, range) || inRange(item.closedAt, range));
    },

    async openPullRequests() {
      const raw = await collectPages(`${repo} open pull requests`, (page) =>
        request(
          "GET",
          githubRepoUrl(
            target.org,
            target.repoName,
            `/pulls?state=open&sort=created&direction=asc&per_page=${PAGE_SIZE}&page=${page}`,
          ),
          token,
        ));
      return raw.map((item) => normalizePullRequest(item));
    },

    async openIssues(labels = []) {
      const labelQuery = labels.length > 0 ? `&labels=${encodeURIComponent(labels.join(","))}` : "";
      const raw = await collectPages(`${repo} open issues`, (page) =>
        request(
          "GET",
          githubRepoUrl(
            target.org,
            target.repoName,
            `/issues?state=open${labelQuery}&per_page=${PAGE_SIZE}&page=${page}`,
          ),
          token,
        ));
      return raw.filter((item) => !isPullRequest(item)).map(normalizeIssue);
    },
  };
}

function giteaSudoUser(target: FileTarget): string {
  if (!target.sudoUser) throw new Error("Gitea repository activity target missing sudoUser");
  return target.sudoUser;
}

function giteaActivityApi(
  target: FileTarget,
  giteaRequest: RepositoryActivityDependencies["giteaApiAsUser"],
): RepositoryActivityApi {
  const sudoUser = giteaSudoUser(target);
  const repo = `${target.org}/${target.repoName}`;
  const request = (path: string) => giteaRequest(sudoUser, target.org, path);

  return {
    async mergedPullRequests(range) {
      const raw = await collectPages(`${repo} merged pull requests`, (page) =>
        request(
          `${target.repoName}/issues?state=closed&type=pulls` +
            `&since=${encodeURIComponent(dayStartUtc(range.since))}` +
            `&limit=${PAGE_SIZE}&page=${page}`,
        ));
      return raw
        .filter((item) => isMerged(item))
        .map((item) => normalizePullRequest(item))
        .filter((item) => inRange(item.mergedAt, range));
    },

    async commits(range) {
      const raw = await collectPages(`${repo} commits`, (page) =>
        request(
          `${target.repoName}/commits?since=${encodeURIComponent(dayStartUtc(range.since))}` +
            `&until=${encodeURIComponent(dayStartUtc(range.until))}` +
            `&stat=false&verification=false&files=false&limit=${PAGE_SIZE}&page=${page}`,
        ));
      return raw.map(normalizeCommit).filter((item) => inRange(item.committedAt, range));
    },

    async issues(range) {
      const raw = await collectPages(`${repo} issue activity`, (page) =>
        request(
          `${target.repoName}/issues?state=all&type=issues` +
            `&since=${encodeURIComponent(dayStartUtc(range.since))}` +
            `&limit=${PAGE_SIZE}&page=${page}`,
        ));
      return raw
        .filter((item) => !isPullRequest(item))
        .map(normalizeIssue)
        .filter((item) => inRange(item.createdAt, range) || inRange(item.closedAt, range));
    },

    async openPullRequests() {
      const raw = await collectPages(`${repo} open pull requests`, (page) =>
        request(
          `${target.repoName}/issues?state=open&type=pulls&limit=${PAGE_SIZE}&page=${page}`,
        ));
      return raw.map((item) => normalizePullRequest(item));
    },

    async openIssues(labels = []) {
      const labelQuery = labels.length > 0 ? `&labels=${encodeURIComponent(labels.join(","))}` : "";
      const raw = await collectPages(`${repo} open issues`, (page) =>
        request(
          `${target.repoName}/issues?state=open&type=issues${labelQuery}` +
            `&limit=${PAGE_SIZE}&page=${page}`,
        ));
      return raw.filter((item) => !isPullRequest(item)).map(normalizeIssue);
    },
  };
}

export function createRepositoryActivityApi(
  target: FileTarget,
  deps?: RepositoryActivityDependencies,
): RepositoryActivityApi {
  return target.provider === "github"
    ? githubActivityApi(target, deps?.githubJson ?? githubJson)
    : giteaActivityApi(target, deps?.giteaApiAsUser ?? giteaApiAsUser);
}
