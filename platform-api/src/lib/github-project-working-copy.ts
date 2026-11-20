import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConnectorTokenReadError, readConnectorAccessToken } from "@octogee/core/connectors/connector-tokens";
import { createProjectGiteaRepo, giteaGetRepo, GITEA_URL, getToken } from "@octogee/core/git-host/gitea-client";
import { githubJson, githubRepoUrl, isValidGithubRepoSource } from "@octogee/core/git-host/github";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { WORKSPACE_GIT_HARDENING_ENV, WORKSPACE_GIT_HARDENING_PINS } from "@octogee/core/workspace/workspace-git";
import {
  GITHUB_PROJECT_METADATA,
  githubCheckpointBranch,
  githubCheckpointRepo,
  projectRepoSourceFromDoc,
  type GitHubProjectWorkingCopy,
  type ProjectRepoSource,
} from "@octogee/shared/types/project";
import type { ProjectCtx } from "./withProject.js";

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
type Repository = { url: string; authorization: string };
type ProjectKey = Pick<ProjectCtx, "wid" | "pid" | "uid">;

export class GithubProjectError extends Error {
  constructor(readonly status: 409 | 422, message: string) {
    super(message);
  }
}

async function runGit(dir: string, args: string[], remote?: Repository): Promise<string> {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ...WORKSPACE_GIT_HARDENING_ENV };
  const config = ["-c", "http.followRedirects=false"];
  if (remote) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${remote.url}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${remote.authorization}`;
    if (new URL(remote.url).protocol === "http:") config.push("-c", "protocol.http.allow=always");
  }
  try {
    const result = await exec("/usr/bin/git", [...WORKSPACE_GIT_HARDENING_PINS, ...config, ...args], {
      cwd: dir, env, timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (cause) {
    const failure = cause as { code?: number | string; stderr?: string; stdout?: string };
    if (args[0] === "push" && /\[(?:rejected|remote rejected)\].*\((?:non-fast-forward|fetch first)\)/u.test(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`)) {
      throw new GithubProjectError(409, "The remote branch has diverged. Both versions have been retained.");
    }
    throw new Error(`Project git ${args[0]} failed (${failure.code ?? "timeout"})`);
  }
}

async function withRepository<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "github-project-"));
  try {
    await runGit(root, ["init", "--bare", "."]);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function remote(url: string, basic: string): Repository {
  return { url, authorization: Buffer.from(basic).toString("base64") };
}

function githubRemote(source: ProjectRepoSource, token: string): Repository {
  if (!isValidGithubRepoSource(source) || [".", ".."].includes(source.repo)) throw new Error("Invalid GitHub repository");
  return remote(`https://github.com/${source.owner}/${source.repo}.git`, `x-access-token:${token}`);
}

async function privateRemote(wid: string, repo: string, branch: string): Promise<Repository> {
  const record = await giteaGetRepo(wid, repo) as { private?: unknown; default_branch?: unknown } | null;
  if (!record || record.private !== true || record.default_branch !== branch) {
    throw new Error("Private project checkpoint repository is unavailable");
  }
  const url = new URL(GITEA_URL);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/${wid}/${repo}.git`;
  return remote(url.href, `${getToken()}:x-oauth-basic`);
}

async function githubToken(key: ProjectKey): Promise<string> {
  try {
    const token = await readConnectorAccessToken(key.uid, "github", {
      kind: "project", requestingUid: key.uid, workspaceSlug: key.wid, projectSlug: key.pid,
    });
    if (token) return token;
  } catch (error) {
    if (!(error instanceof ConnectorTokenReadError) || error.errorCode !== "reauth_required") throw error;
  }
  throw new GithubProjectError(422, "Connect GitHub to continue. Your private checkpoint is retained.");
}

function githubRequest(source: ProjectRepoSource, token: string, suffix: string, body?: unknown): Promise<unknown> {
  return githubJson(body === undefined ? "GET" : "POST", githubRepoUrl(source.owner, source.repo, suffix), token, body, AbortSignal.timeout(20_000))
    .catch(error => {
      if (error instanceof Error && /^GitHub API (401|403|404)$/u.test(error.message)) {
        throw new GithubProjectError(422, "GitHub access is unavailable. Your private checkpoint is retained.");
      }
      throw error;
    });
}

async function githubRepository(source: ProjectRepoSource, token: string) {
  const record = await githubRequest(source, token, "") as { id?: unknown; default_branch?: unknown };
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id) || record.id < 1 ||
      typeof record.default_branch !== "string" || !record.default_branch || record.default_branch.length > 255) {
    throw new Error("GitHub did not return a repository identity and default branch");
  }
  return { id: record.id, defaultBranch: record.default_branch };
}

function sameSource(a: ProjectRepoSource | null, b: ProjectRepoSource): a is ProjectRepoSource {
  return a?.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

async function readCurrent(key: ProjectKey, source: ProjectRepoSource, copy: GitHubProjectWorkingCopy): Promise<void> {
  const record = await platformStateStore.workspaces.projects.get(key.wid, key.pid);
  const current = projectRepoSourceFromDoc(record?.repoSource);
  if (record?.ownerUid !== key.uid || record.checkoutEnabled === false ||
      record.commercialLifecycleStatus === "archived" || !sameSource(current, source) ||
      current.workingCopy?.id !== copy.id) {
    throw new GithubProjectError(409, "The project checkout changed. Reload its settings and retry.");
  }
}

async function reserveCopy(key: ProjectKey, source: ProjectRepoSource): Promise<GitHubProjectWorkingCopy> {
  let proposed = source.workingCopy;
  if (!proposed) {
    const token = await githubToken(key);
    const { id, defaultBranch } = await githubRepository(source, token);
    const commit = await githubRequest(source, token, `/commits/${encodeURIComponent(defaultBranch)}`) as { sha?: unknown };
    if (typeof commit.sha !== "string" || !SHA.test(commit.sha)) throw new Error("GitHub did not return a base commit");
    proposed = { id: randomBytes(16).toString("hex"), repositoryId: id, baseBranch: defaultBranch, baseCommit: commit.sha, ready: false };
  }
  const candidate = proposed;
  return platformStateStore.transaction({ label: "github-project.reserve" }, async tx => {
    const record = await tx.workspaces.projects.get(key.wid, key.pid);
    const current = projectRepoSourceFromDoc(record?.repoSource);
    if (record?.ownerUid !== key.uid || !sameSource(current, source) || record.commercialLifecycleStatus === "archived") {
      throw new GithubProjectError(409, "The project repository changed. Reload its settings and retry.");
    }
    const workingCopy = current.workingCopy ?? candidate;
    await tx.workspaces.projects.patch(key.wid, key.pid, { repoSource: { ...record.repoSource, workingCopy }, checkoutEnabled: true });
    return workingCopy;
  });
}

async function fetchRef(dir: string, source: Repository, ref: string): Promise<string> {
  await runGit(dir, ["fetch", "--no-tags", "--no-recurse-submodules", "--", source.url, ref], source);
  const sha = await runGit(dir, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
  if (!SHA.test(sha)) throw new Error("Project source ref did not resolve to a commit");
  return sha;
}

async function pushRef(dir: string, target: Repository, sha: string, branch: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Invalid project commit");
  await runGit(dir, ["push", "--porcelain", "--no-follow-tags", "--no-recurse-submodules", "--", target.url, `${sha}:refs/heads/${branch}`], target);
}

async function finishCopy(key: ProjectKey, source: ProjectRepoSource, copy: GitHubProjectWorkingCopy): Promise<void> {
  await platformStateStore.transaction({ label: "github-project.activate" }, async tx => {
    const record = await tx.workspaces.projects.get(key.wid, key.pid);
    const current = projectRepoSourceFromDoc(record?.repoSource);
    if (record?.ownerUid !== key.uid || !sameSource(current, source) || current.workingCopy?.id !== copy.id) {
      throw new GithubProjectError(409, "The project repository changed. Reload its settings and retry.");
    }
    await tx.workspaces.projects.patch(key.wid, key.pid, { repoSource: { ...record.repoSource, workingCopy: { ...current.workingCopy, ready: true } } });
  });
}

export async function enableGithubProjectCheckout(key: ProjectKey, source: ProjectRepoSource): Promise<void> {
  const copy = await reserveCopy(key, source);
  if (copy.ready) return;
  const repo = githubCheckpointRepo(copy.id);
  const branch = githubCheckpointBranch(repo)!;
  await createProjectGiteaRepo(key.wid, repo, "Private project checkpoint", true, { defaultBranch: branch, autoInit: false });
  const checkpoint = await privateRemote(key.wid, repo, branch);
  await withRepository(async dir => {
    const existing = await runGit(dir, ["ls-remote", "--heads", "--", checkpoint.url, `refs/heads/${branch}`], checkpoint);
    if (existing) return;
    const token = await githubToken(key);
    if ((await githubRepository(source, token)).id !== copy.repositoryId) {
      throw new GithubProjectError(409, "The connected GitHub repository has changed.");
    }
    const sha = await fetchRef(dir, githubRemote(source, token), copy.baseCommit);
    if (sha !== copy.baseCommit) throw new Error("GitHub returned a different base commit");
    await readCurrent(key, source, copy);
    await pushRef(dir, checkpoint, sha, branch);
  });
  await finishCopy(key, source, copy);
}

interface PullRequest {
  url: string;
  state: string;
}

function readPullRequest(raw: unknown, source: ProjectRepoSource): PullRequest {
  const value = raw as { number?: unknown; state?: unknown } | null;
  if (typeof value?.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1 ||
      typeof value.state !== "string") throw new Error("GitHub returned an invalid pull request");
  return { state: value.state, url: `https://github.com/${source.owner}/${source.repo}/pull/${value.number}` };
}

async function findPullRequest(source: ProjectRepoSource, token: string, branch: string, base: string): Promise<PullRequest | null> {
  const query = new URLSearchParams({ state: "all", head: `${source.owner}:${branch}`, base });
  const results = await githubRequest(source, token, `/pulls?${query}`);
  if (!Array.isArray(results) || results.length > 1) throw new GithubProjectError(409, "Multiple pull requests use the project branch.");
  return results.length ? readPullRequest(results[0], source) : null;
}

async function verifyPublishable(dir: string, base: string, sha: string): Promise<void> {
  if (sha === base) throw new GithubProjectError(409, "Save project changes before opening a pull request.");
  try {
    await runGit(dir, ["merge-base", "--is-ancestor", base, sha]);
  } catch {
    throw new GithubProjectError(409, "The private checkpoint no longer descends from the recorded GitHub base.");
  }
  const metadata = await runGit(dir, ["log", "--format=%H", "--full-history", "-m", "-1", `${base}..${sha}`, "--", GITHUB_PROJECT_METADATA]);
  if (metadata) throw new GithubProjectError(409, "Project history changes Octogee’s reserved asset manifest. Resolve that change before publishing.");
}

async function savePullRequest(key: ProjectKey, copy: GitHubProjectWorkingCopy, result: PullRequest): Promise<void> {
  await platformStateStore.transaction({ label: "github-project.pull-request" }, async tx => {
    const record = await tx.workspaces.projects.get(key.wid, key.pid);
    const current = projectRepoSourceFromDoc(record?.repoSource)?.workingCopy;
    if (record?.ownerUid !== key.uid || current?.id !== copy.id) return;
    await tx.workspaces.projects.patch(key.wid, key.pid, { repoSource: { ...record.repoSource, workingCopy: { ...current, pullRequestUrl: result.url } } });
  });
}

export async function publishGithubProject(key: ProjectKey, source: ProjectRepoSource, title: string): Promise<PullRequest> {
  const copy = source.workingCopy;
  if (!copy?.ready) throw new GithubProjectError(409, "Enable the private project checkout first.");
  const repo = githubCheckpointRepo(copy.id);
  const branch = githubCheckpointBranch(repo)!;
  await readCurrent(key, source, copy);
  const token = await githubToken(key);
  return withRepository(async dir => {
    const checkpoint = await privateRemote(key.wid, repo, branch);
    const sha = await fetchRef(dir, checkpoint, `refs/heads/${branch}`);
    await verifyPublishable(dir, copy.baseCommit, sha);
    const current = await githubRepository(source, token);
    if (current.id !== copy.repositoryId || branch === copy.baseBranch || branch === current.defaultBranch) {
      throw new GithubProjectError(409, "The project branch is no longer a safe GitHub destination.");
    }
    const existing = await findPullRequest(source, token, branch, copy.baseBranch);
    if (existing && existing.state !== "open") throw new GithubProjectError(409, "The project pull request is closed. The private checkpoint is retained.");
    await readCurrent(key, source, copy);
    await pushRef(dir, githubRemote(source, token), sha, branch);
    let result = existing;
    if (!result) {
      await readCurrent(key, source, copy);
      try {
        const created = await githubRequest(source, token, "/pulls", { title, head: branch, base: copy.baseBranch, draft: true });
        result = readPullRequest(created, source);
      } catch (error) {
        result = await findPullRequest(source, token, branch, copy.baseBranch);
        if (!result) throw error;
      }
    }
    await savePullRequest(key, copy, result);
    return result;
  });
}
