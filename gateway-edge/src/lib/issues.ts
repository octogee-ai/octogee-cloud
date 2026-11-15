import type { FileTarget } from "@octogee/core/workspace/fileTarget";
import { giteaApiAsUser } from "@octogee/core/git-host/gitea-client";
import {
  githubIssuesApi,
  githubLabelsApi,
  githubJson,
  githubRepoUrl,
  GITHUB_ISSUES_PER_PAGE,
} from "@octogee/core/git-host/github";
import {
  isPullRequest,
  normalizeComment,
  normalizeComments,
  normalizeIssue,
  normalizeIssues,
  normalizeLabels,
  type WorkspaceComment,
  type WorkspaceIssue,
  type WorkspaceLabel,
} from "./issues-normalize.js";
import {
  computeLabelReplacement,
  computeMove,
  labelForColumn,
  seedForLabel,
  STATUS_LABEL_SEED,
  targetState,
  type ColumnKey,
} from "./issues-write.js";
import { logger } from "@octogee/core/http/logging";

const GITEA_ISSUES_LIMIT = 100;

function giteaSudo(target: FileTarget): string {
  if (!target.sudoUser) throw new Error("gitea issues target missing sudoUser");
  return target.sudoUser;
}

export async function listIssues(target: FileTarget): Promise<WorkspaceIssue[]> {
  const cap = target.provider === "github" ? GITHUB_ISSUES_PER_PAGE : GITEA_ISSUES_LIMIT;
  const raw =
    target.provider === "github"
      ? await githubIssuesApi(target.org, target.repoName, target.githubToken)
      : await giteaApiAsUser(
          giteaSudo(target),
          target.org,
          `${target.repoName}/issues?state=all&type=issues&limit=${GITEA_ISSUES_LIMIT}`,
        );
  if (Array.isArray(raw) && raw.length >= cap) {
    logger.warn(`[issues] page cap ${cap} hit for ${target.org}/${target.repoName} — older issues not loaded`);
  }
  return normalizeIssues(raw);
}

export async function listLabels(target: FileTarget): Promise<WorkspaceLabel[]> {
  const raw =
    target.provider === "github"
      ? await githubLabelsApi(target.org, target.repoName, target.githubToken)
      : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels?limit=${GITEA_ISSUES_LIMIT}`);
  return normalizeLabels(raw);
}

// --- Write path ---------------------------------------------------------------
// GitHub applies labels by name; Gitea by numeric id. So writes resolve a name->id
// map (Gitea) and seed the status:* labels if absent (both providers need them to
// exist before a move can apply one). GitHub writes go as the brokered owner token,
// so issue authorship is the owner; Gitea writes are sudo'd as the acting member.

interface RepoLabel {
  id: number;
  name: string;
}

function rawId(raw: unknown): number {
  return Number((raw as { id?: unknown })?.id) || 0;
}

async function loadRepoLabels(target: FileTarget): Promise<RepoLabel[]> {
  const raw =
    target.provider === "github"
      ? await githubLabelsApi(target.org, target.repoName, target.githubToken)
      : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels?limit=${GITEA_ISSUES_LIMIT}`);
  return (Array.isArray(raw) ? raw : []).map((l) => ({ id: rawId(l), name: String((l as { name?: unknown }).name ?? "") }));
}

// Provider label names are case-insensitive on lookup (GitHub treats `Bug`
// and `bug` as the same label), so maps key on the lowercased name — creating
// a "duplicate" that differs only in case 422s on GitHub.
function labelKey(name: string): string {
  return name.toLowerCase();
}

async function ensureStatusLabels(target: FileTarget): Promise<Map<string, number>> {
  const byName = new Map((await loadRepoLabels(target)).map((l) => [labelKey(l.name), l.id]));
  for (const seed of STATUS_LABEL_SEED) {
    if (byName.has(labelKey(seed.name))) continue;
    const created =
      target.provider === "github"
        ? await githubJson("POST", githubRepoUrl(target.org, target.repoName, "/labels"), target.githubToken, seed)
        : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels`, "POST", seed);
    byName.set(labelKey(seed.name), rawId(created));
  }
  return byName;
}

// On GitHub (and Gitea) a pull request shares the issue-number space and is reachable
// at /issues/:n. The Board never shows PRs (the read path filters them) and a write must
// never touch one — so reject before any label/state mutation.
export class NotAnIssueError extends Error {
  constructor(num: number) {
    super(`#${num} is a pull request, not an issue`);
    this.name = "NotAnIssueError";
  }
}

export class IssueNotFoundError extends Error {
  constructor(num: number) {
    super(`issue #${num} does not exist`);
    this.name = "IssueNotFoundError";
  }
}

const PROVIDER_404_RE = /\bAPI 404\b/;

async function getIssue(target: FileTarget, num: number): Promise<WorkspaceIssue> {
  let raw: unknown;
  try {
    raw =
      target.provider === "github"
        ? await githubJson("GET", githubRepoUrl(target.org, target.repoName, `/issues/${num}`), target.githubToken)
        : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}`);
  } catch (e) {
    if (e instanceof Error && PROVIDER_404_RE.test(e.message)) throw new IssueNotFoundError(num);
    throw e;
  }
  if (isPullRequest(raw)) throw new NotAnIssueError(num);
  return normalizeIssue(raw);
}

// Every mutation path resolves the issue first (PR + existence guard); exposed
// so attachment writes can enforce the same boundary without a full detail read.
export async function assertIssueExists(target: FileTarget, num: number): Promise<void> {
  await getIssue(target, num);
}

async function removeLabel(target: FileTarget, num: number, name: string, map: Map<string, number>): Promise<void> {
  if (target.provider === "github") {
    await githubJson(
      "DELETE",
      githubRepoUrl(target.org, target.repoName, `/issues/${num}/labels/${encodeURIComponent(name)}`),
      target.githubToken,
    );
    return;
  }
  const id = map.get(labelKey(name));
  if (id == null) return;
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}/labels/${id}`, "DELETE");
}

async function addLabel(target: FileTarget, num: number, name: string, map: Map<string, number>): Promise<void> {
  if (target.provider === "github") {
    await githubJson("POST", githubRepoUrl(target.org, target.repoName, `/issues/${num}/labels`), target.githubToken, {
      labels: [name],
    });
    return;
  }
  const id = map.get(labelKey(name));
  if (id == null) return;
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}/labels`, "POST", { labels: [id] });
}

async function setIssueState(target: FileTarget, num: number, state: "open" | "closed"): Promise<void> {
  if (target.provider === "github") {
    await githubJson("PATCH", githubRepoUrl(target.org, target.repoName, `/issues/${num}`), target.githubToken, { state });
    return;
  }
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}`, "PATCH", { state });
}

export interface CreateIssueInput {
  title: string;
  body: string;
  status: ColumnKey;
  labels?: string[];
}

export async function createIssue(target: FileTarget, input: CreateIssueInput): Promise<WorkspaceIssue> {
  const statusLabel = labelForColumn(input.status);
  const names = computeLabelReplacement(statusLabel ? [statusLabel] : [], input.labels ?? []);
  if (statusLabel) await ensureStatusLabels(target);
  const map = names.length > 0 ? await ensureRequestedLabels(target, names) : new Map<string, number>();
  let issue: WorkspaceIssue;
  if (target.provider === "github") {
    const raw = await githubJson("POST", githubRepoUrl(target.org, target.repoName, "/issues"), target.githubToken, {
      title: input.title,
      body: input.body,
      ...(names.length > 0 ? { labels: names } : {}),
    });
    issue = normalizeIssue(raw);
  } else {
    const ids = names.map((name) => map.get(labelKey(name))).filter((id): id is number => id != null && id > 0);
    const raw = await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues`, "POST", {
      title: input.title,
      body: input.body,
      ...(ids.length > 0 ? { labels: ids } : {}),
    });
    issue = normalizeIssue(raw);
  }
  // Providers only create OPEN issues; a card added straight to Done must
  // close, or it lands in Backlog.
  if (targetState(input.status) === "closed") {
    await setIssueState(target, issue.number, "closed");
    return getIssue(target, issue.number);
  }
  return issue;
}

export async function moveIssue(target: FileTarget, num: number, status: ColumnKey): Promise<WorkspaceIssue> {
  const issue = await getIssue(target, num);
  const plan = computeMove(issue.labels, status);
  const map = await ensureStatusLabels(target);
  await Promise.all(plan.remove.map((name) => removeLabel(target, num, name, map)));
  if (plan.add) await addLabel(target, num, plan.add, map);
  if (issue.state !== plan.state) await setIssueState(target, num, plan.state);
  return getIssue(target, num);
}

export interface IssueDetail {
  issue: WorkspaceIssue;
  comments: WorkspaceComment[];
}

export async function getIssueDetail(target: FileTarget, num: number): Promise<IssueDetail> {
  const [issue, comments] = await Promise.all([getIssue(target, num), listComments(target, num)]);
  return { issue, comments };
}

async function listComments(target: FileTarget, num: number): Promise<WorkspaceComment[]> {
  const raw =
    target.provider === "github"
      ? await githubJson(
          "GET",
          githubRepoUrl(target.org, target.repoName, `/issues/${num}/comments?per_page=${GITHUB_ISSUES_PER_PAGE}`),
          target.githubToken,
        )
      : await giteaApiAsUser(
          giteaSudo(target),
          target.org,
          `${target.repoName}/issues/${num}/comments?limit=${GITEA_ISSUES_LIMIT}`,
        );
  return normalizeComments(raw);
}

export async function addComment(target: FileTarget, num: number, body: string): Promise<WorkspaceComment> {
  await getIssue(target, num); // NotAnIssueError guard — a comment must never land on a PR
  const raw =
    target.provider === "github"
      ? await githubJson(
          "POST",
          githubRepoUrl(target.org, target.repoName, `/issues/${num}/comments`),
          target.githubToken,
          { body },
        )
      : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}/comments`, "POST", {
          body,
        });
  return normalizeComment(raw);
}

export interface UpdateIssueInput {
  title?: string;
  body?: string;
  labels?: string[];
}

async function ensureRequestedLabels(target: FileTarget, names: string[]): Promise<Map<string, number>> {
  const byName = new Map((await loadRepoLabels(target)).map((l) => [labelKey(l.name), l.id]));
  for (const name of names) {
    if (byName.has(labelKey(name))) continue;
    const seed = seedForLabel(name);
    const created =
      target.provider === "github"
        ? await githubJson("POST", githubRepoUrl(target.org, target.repoName, "/labels"), target.githubToken, seed)
        : await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/labels`, "POST", seed);
    byName.set(labelKey(name), rawId(created));
  }
  return byName;
}

async function replaceLabels(target: FileTarget, num: number, names: string[]): Promise<void> {
  const map = await ensureRequestedLabels(target, names);
  if (target.provider === "github") {
    await githubJson("PUT", githubRepoUrl(target.org, target.repoName, `/issues/${num}/labels`), target.githubToken, {
      labels: names,
    });
    return;
  }
  const ids = names.map((name) => map.get(labelKey(name))).filter((id): id is number => id != null && id > 0);
  await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}/labels`, "PUT", {
    labels: ids,
  });
}

export async function updateIssue(target: FileTarget, num: number, input: UpdateIssueInput): Promise<WorkspaceIssue> {
  const issue = await getIssue(target, num);
  const patch: Record<string, string> = {};
  if (input.title !== undefined && input.title !== issue.title) patch.title = input.title;
  if (input.body !== undefined && input.body !== issue.body) patch.body = input.body;
  if (Object.keys(patch).length > 0) {
    if (target.provider === "github") {
      await githubJson("PATCH", githubRepoUrl(target.org, target.repoName, `/issues/${num}`), target.githubToken, patch);
    } else {
      await giteaApiAsUser(giteaSudo(target), target.org, `${target.repoName}/issues/${num}`, "PATCH", patch);
    }
  }
  if (input.labels !== undefined) {
    await replaceLabels(target, num, computeLabelReplacement(issue.labels, input.labels));
  }
  return getIssue(target, num);
}
