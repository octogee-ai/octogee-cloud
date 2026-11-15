import { createHash } from "node:crypto";

import { logger } from "../http/logging.js";

const GITHUB_API = "https://api.github.com";
const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_CONDITIONAL_CACHE_MAX = 500;

interface GithubConditionalCacheEntry {
  etag: string;
  value: unknown;
}

const githubConditionalCache = new Map<string, GithubConditionalCacheEntry>();

export function clearGithubConditionalCache(): void {
  githubConditionalCache.clear();
}

function repoScope(url: string): string {
  const m = url.match(/\/repos\/([^/]+)\/([^/?]+)/);
  return m ? `${m[1]}/${m[2]}` : "global";
}

function githubConditionalCacheKey(url: string, token: string | undefined): string {
  return `${repoScope(url)}||${createHash("sha256").update(token ?? "").digest("hex")}:${url}`;
}

// Drop only the validators for the mutated repo — a write to one user's repo
// must not flush every other tenant's ETags in the shared octogee-api process.
export function invalidateGithubConditionalCacheForUrl(url: string): void {
  const prefix = `${repoScope(url)}||`;
  for (const key of githubConditionalCache.keys()) {
    if (key.startsWith(prefix)) githubConditionalCache.delete(key);
  }
}

function addGithubConditionalEntry(key: string, entry: GithubConditionalCacheEntry): void {
  if (githubConditionalCache.has(key)) githubConditionalCache.delete(key);
  githubConditionalCache.set(key, entry);
  while (githubConditionalCache.size > GITHUB_CONDITIONAL_CACHE_MAX) {
    const oldest = githubConditionalCache.keys().next().value;
    if (!oldest) return;
    githubConditionalCache.delete(oldest);
  }
}

function parseGithubJson(resp: Response): Promise<unknown> {
  if (resp.status === 204) return Promise.resolve(null);
  return resp.text().then((text) => (text ? JSON.parse(text) : null));
}

async function fetchGithubJson(
  method: string,
  url: string,
  token: string | undefined,
  body?: unknown,
  options: { notFoundMessage?: string; signal?: AbortSignal } = {},
): Promise<unknown> {
  const { notFoundMessage, signal } = options;
  const upperMethod = method.toUpperCase();
  const cacheable = upperMethod === "GET" && body === undefined;
  const cacheKey = cacheable ? githubConditionalCacheKey(url, token) : null;
  const cached = cacheKey ? githubConditionalCache.get(cacheKey) : undefined;

  const send = (useValidator: boolean) =>
    fetch(url, {
      method: upperMethod,
      ...(signal ? { signal } : {}),
      headers: {
        ...githubHeaders(token),
        ...(useValidator && cached ? { "If-None-Match": cached.etag } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let resp = await send(true);
  if (resp.status === 304) {
    if (cached && cacheKey) {
      addGithubConditionalEntry(cacheKey, cached); // refresh LRU recency on a hit
      return cached.value;
    }
    // Validator was evicted between building headers and the response — re-fetch
    // once unconditionally rather than failing a request that would otherwise succeed.
    logger.warn(`GitHub API 304 without cached validator, retrying: ${upperMethod} ${url}`);
    resp = await send(false);
  }
  if (!resp.ok) {
    if (resp.status === 404 && notFoundMessage) throw new Error(notFoundMessage);
    const text = await resp.text().catch(() => "");
    logger.error(`GitHub API error: ${resp.status} ${upperMethod} ${url}`, { response: text.slice(0, 500) });
    throw new Error(`GitHub API ${resp.status}`);
  }
  if (upperMethod !== "GET") invalidateGithubConditionalCacheForUrl(url);
  const value = await parseGithubJson(resp);
  const etag = resp.headers.get("etag");
  if (cacheKey && etag) addGithubConditionalEntry(cacheKey, { etag, value });
  return value;
}

export function githubContentsUrl(owner: string, repo: string, path: string): string {
  if (!OWNER_RE.test(owner)) throw new Error(`Invalid GitHub owner: ${owner}`);
  if (!REPO_RE.test(repo)) throw new Error(`Invalid GitHub repo: ${repo}`);
  const suffix = path ? `/${path}` : "";
  return `${GITHUB_API}/repos/${owner}/${repo}/contents${suffix}`;
}

export function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "octogee-workspace",
  };
}

export function isOversizeFile(file: { encoding?: string }): boolean {
  return file.encoding === "none";
}

export async function githubContentsApi(
  owner: string,
  repo: string,
  path: string,
  token: string | undefined,
  ref?: string,
): Promise<unknown> {
  const url = githubContentsUrl(owner, repo, path) + (ref ? `?ref=${encodeURIComponent(ref)}` : "");
  return fetchGithubJson("GET", url, token, undefined, { notFoundMessage: "GitHub API 404" });
}

export async function githubCommitsApi(
  owner: string,
  repo: string,
  path: string,
  token: string | undefined,
  ref?: string,
): Promise<unknown> {
  const sha = ref ? `&sha=${encodeURIComponent(ref)}` : "";
  const suffix = `/commits?path=${encodeURIComponent(path)}&per_page=1${sha}`;
  return githubJson("GET", githubRepoUrl(owner, repo, suffix), token);
}

export async function githubRepoApi(
  owner: string,
  repo: string,
  token: string | undefined,
): Promise<unknown> {
  return githubJson("GET", githubRepoUrl(owner, repo, ""), token);
}

export async function githubBranchesApi(
  owner: string,
  repo: string,
  token: string | undefined,
): Promise<unknown> {
  return githubJson("GET", githubRepoUrl(owner, repo, "/branches?per_page=100"), token);
}

export async function githubTreeApi(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
): Promise<unknown> {
  return githubJson("GET", githubRepoUrl(owner, repo, `/git/trees/${encodeURIComponent(ref)}?recursive=1`), token);
}

export function githubRepoUrl(owner: string, repo: string, suffix: string): string {
  if (!OWNER_RE.test(owner)) throw new Error(`Invalid GitHub owner: ${owner}`);
  if (!REPO_RE.test(repo)) throw new Error(`Invalid GitHub repo: ${repo}`);
  return `${GITHUB_API}/repos/${owner}/${repo}${suffix}`;
}

export async function githubJson(
  method: string,
  url: string,
  token: string | undefined,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return fetchGithubJson(method, url, token, body, { signal });
}

export const GITHUB_ISSUES_PER_PAGE = 100;

export async function githubIssuesApi(
  owner: string,
  repo: string,
  token: string | undefined,
): Promise<unknown> {
  return githubJson("GET", githubRepoUrl(owner, repo, `/issues?state=all&per_page=${GITHUB_ISSUES_PER_PAGE}`), token);
}

export async function githubLabelsApi(
  owner: string,
  repo: string,
  token: string | undefined,
): Promise<unknown> {
  return githubJson("GET", githubRepoUrl(owner, repo, `/labels?per_page=${GITHUB_ISSUES_PER_PAGE}`), token);
}

export interface GithubContentsPutBody {
  message: string;
  contentBase64: string;
  sha?: string;
  author?: { name: string; email: string };
}

export async function githubContentsPut(
  owner: string,
  repo: string,
  path: string,
  token: string | undefined,
  body: GithubContentsPutBody,
): Promise<unknown> {
  const url = githubContentsUrl(owner, repo, path);
  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...githubHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: body.message,
      content: body.contentBase64,
      ...(body.sha ? { sha: body.sha } : {}),
      ...(body.author ? { author: body.author } : {}),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error(`GitHub API error: ${resp.status} PUT ${url}`, {
      response: text.slice(0, 500),
    });
    throw new Error(`GitHub API ${resp.status}`);
  }
  invalidateGithubConditionalCacheForUrl(url);
  return resp.json();
}

export interface GithubRepoSummary {
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
  description: string | null;
  updatedAt: string;
  defaultBranch: string;
  sizeKiB: number;
}

interface GithubRepoRaw {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  default_branch: string;
  size: number;
  owner: { login: string };
}

export const GITHUB_REPOS_PAGE = 100;
export const GITHUB_REPOS_MAX_PAGES = 10;

export function githubReposUrl(page = 1): string {
  return `${GITHUB_API}/user/repos?per_page=${GITHUB_REPOS_PAGE}&page=${page}&sort=full_name&affiliation=owner,collaborator,organization_member`;
}

export function toRepoSummary(r: GithubRepoRaw): GithubRepoSummary {
  return {
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    updatedAt: r.updated_at,
    defaultBranch: r.default_branch,
    sizeKiB: r.size,
  };
}

export async function githubListRepos(
  token: string,
): Promise<{ repos: GithubRepoSummary[]; truncated: boolean }> {
  const repos: GithubRepoSummary[] = [];
  let page = 1;
  for (; page <= GITHUB_REPOS_MAX_PAGES; page++) {
    const raw = (await githubJson("GET", githubReposUrl(page), token)) as GithubRepoRaw[];
    repos.push(...raw.map(toRepoSummary));
    if (raw.length < GITHUB_REPOS_PAGE) break;
  }
  return { repos, truncated: page > GITHUB_REPOS_MAX_PAGES };
}

export interface GithubRepoSource {
  provider: "github";
  owner: string;
  repo: string;
}

const GITHUB_REPO_URL_HOSTS = new Set(["github.com", "www.github.com"]);

export function parseGithubRepoUrl(value: unknown): GithubRepoSource | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!GITHUB_REPO_URL_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;

  const candidate = {
    provider: "github" as const,
    owner: segments[0],
    repo: segments[1].replace(/\.git$/i, ""),
  };
  return isValidGithubRepoSource(candidate) ? candidate : null;
}

export function isValidGithubRepoSource(rs: unknown): rs is GithubRepoSource {
  if (!rs || typeof rs !== "object") return false;
  const r = rs as { provider?: unknown; owner?: unknown; repo?: unknown };
  return (
    r.provider === "github" &&
    typeof r.owner === "string" &&
    OWNER_RE.test(r.owner) &&
    typeof r.repo === "string" &&
    REPO_RE.test(r.repo)
  );
}
