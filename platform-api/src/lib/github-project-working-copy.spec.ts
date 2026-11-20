import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubCheckpointBranch, githubCheckpointRepo, type ProjectRepoSource } from "@octogee/shared/types/project";

const h = vi.hoisted(() => ({
  git: vi.fn(),
  token: vi.fn(),
  github: vi.fn(),
  createRepo: vi.fn(),
  getRepo: vi.fn(),
  project: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: h.git }) };
});
vi.mock("@octogee/core/connectors/connector-tokens", () => ({ readConnectorAccessToken: h.token }));
vi.mock("@octogee/core/git-host/gitea-client", () => ({
  GITEA_URL: "https://gitea.example",
  getToken: () => "platform-test-token",
  createProjectGiteaRepo: h.createRepo,
  giteaGetRepo: h.getRepo,
}));
vi.mock("@octogee/core/git-host/github", async importOriginal => ({
  ...await importOriginal<typeof import("@octogee/core/git-host/github")>(),
  githubJson: h.github,
}));
vi.mock("@octogee/core/identity/platform-state-store", () => {
  const workspaces = { projects: { get: h.project, patch: h.patch } };
  return { platformStateStore: { workspaces, transaction: (_options: unknown, use: (tx: unknown) => unknown) => use({ workspaces }) } };
});

import { enableGithubProjectCheckout, publishGithubProject } from "./github-project-working-copy.js";

const key = { wid: "alice", pid: "orbit", uid: "uid-alice" };
const upstream = { provider: "github", owner: "example", repo: "orbit" } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let root: string;
let github: string;
let checkpoint: string;
let baseCommit: string;
let project: { ownerUid: string; checkoutEnabled: boolean; repoSource: ProjectRepoSource };
let pull: { number: number; state: string } | null;
let defaultBranch: string;

beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), "project-checkpoint-test-"));
  github = join(root, "github.git");
  checkpoint = join(root, "checkpoint.git");
  git(root, "init", "--bare", "--initial-branch=main", github);
  git(root, "init", "--initial-branch=main", "source");
  const source = join(root, "source");
  git(source, "config", "user.name", "Project author");
  git(source, "config", "user.email", "author@example.com");
  writeFileSync(join(source, "README.md"), "initial\n");
  git(source, "add", "README.md");
  git(source, "commit", "-m", "initial");
  const submodule = git(source, "rev-parse", "HEAD");
  writeFileSync(join(source, ".gitmodules"), '[submodule "platform"]\n\tpath = platform\n\turl = https://github.com/example/platform.git\n');
  git(source, "add", ".gitmodules");
  git(source, "update-index", "--add", "--cacheinfo", `160000,${submodule},platform`);
  git(source, "commit", "-m", "Pin the platform");
  baseCommit = git(source, "rev-parse", "HEAD");
  git(source, "push", github, "main");
  project = { ownerUid: key.uid, checkoutEnabled: false, repoSource: upstream };
  pull = null;
  defaultBranch = "main";

  h.project.mockImplementation(async () => structuredClone(project));
  h.patch.mockImplementation(async (_wid, _pid, patch: Partial<typeof project>) => {
    project = { ...project, ...patch };
  });
  h.token.mockResolvedValue("owner-connector");
  h.github.mockImplementation(async (method: string, url: string, _token: string, body?: unknown) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/orbit")) return { id: 123, default_branch: defaultBranch };
    if (target.pathname.endsWith("/commits/main")) return { sha: baseCommit };
    if (target.pathname.endsWith("/pulls") && method === "GET") return pull ? [pull] : [];
    if (target.pathname.endsWith("/pulls") && method === "POST") {
      expect(body).toEqual({ title: "Update Orbit", head: branch(), base: "main", draft: true });
      pull = { number: 42, state: "open" };
      return pull;
    }
    throw new Error("Unexpected GitHub request");
  });
  h.createRepo.mockImplementation(async (_org, _repo, _description, privacy, options) => {
    expect(privacy).toBe(true);
    expect(options).toEqual({ defaultBranch: branch(), autoInit: false });
    git(root, "init", "--bare", `--initial-branch=${branch()}`, checkpoint);
  });
  h.getRepo.mockImplementation(async () => ({ private: true, default_branch: branch() }));
  h.git.mockImplementation(async (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    expect(binary).toBe("/usr/bin/git");
    const rewritten = args.map(arg => {
      if (arg === "https://github.com/example/orbit.git") return github;
      if (arg === `https://gitea.example/alice/${githubCheckpointRepo(project.repoSource.workingCopy!.id)}.git`) return checkpoint;
      return arg;
    });
    const transport = rewritten.findIndex(arg => arg === "protocol.file.allow=never");
    rewritten[transport] = "protocol.file.allow=always";
    return { stdout: git(options.cwd, ...rewritten), stderr: "" };
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function branch(): string {
  return githubCheckpointBranch(githubCheckpointRepo(project.repoSource.workingCopy!.id))!;
}

function saveCheckpoint(message: string, file = "README.md", remote = checkpoint): string {
  const dir = mkdtempSync(join(root, "edit-"));
  git(dir, "clone", remote, ".");
  git(dir, "config", "user.name", "Project author");
  git(dir, "config", "user.email", "author@example.com");
  if (file.startsWith(".files/")) mkdirSync(join(dir, ".files"));
  writeFileSync(join(dir, file), `${message}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-m", message);
  git(dir, "push", "origin", `HEAD:refs/heads/${branch()}`);
  return git(dir, "rev-parse", "HEAD");
}

describe("private GitHub project working copy", () => {
  it("seeds privately and restores the exact pinned submodule without creating GitHub refs", async () => {
    await enableGithubProjectCheckout(key, upstream);
    await enableGithubProjectCheckout(key, project.repoSource);
    expect(h.createRepo).toHaveBeenCalledTimes(1);
    expect(project.repoSource.workingCopy).toMatchObject({ repositoryId: 123, baseCommit, baseBranch: "main", ready: true });
    expect(git(github, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
    expect(git(checkpoint, "rev-parse", branch())).toBe(baseCommit);
    expect(git(checkpoint, "ls-tree", branch(), "platform")).toBe(git(github, "ls-tree", "main", "platform"));
    await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).rejects.toThrow("Save project changes");
    expect(git(github, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("creates one draft PR and publishes fast-forward updates to the recorded branch, preserving commit IDs", async () => {
    await enableGithubProjectCheckout(key, upstream);
    const first = saveCheckpoint("First intentional edit");
    const expected = { url: "https://github.com/example/orbit/pull/42", state: "open" };
    await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).resolves.toEqual(expected);
    expect(git(github, "rev-parse", branch())).toBe(first);
    const second = saveCheckpoint("Second intentional edit");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).resolves.toEqual(expected);
    }
    expect(h.github.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(git(github, "rev-parse", branch())).toBe(second);
    expect(git(github, "rev-parse", "main")).toBe(baseCommit);
    expect(git(github, "log", "--format=%H", `main..${branch()}`)).toBe(`${second}\n${first}`);
  });

  it("keeps private work when GitHub authorization is lost or the destination becomes the default branch", async () => {
    await enableGithubProjectCheckout(key, upstream);
    const first = saveCheckpoint("Private edit");
    h.token.mockResolvedValueOnce(null);
    await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).rejects.toMatchObject({ status: 422 });
    const second = saveCheckpoint("Saved offline from GitHub");
    expect(git(checkpoint, "log", "--format=%H", `${baseCommit}..${branch()}`)).toBe(`${second}\n${first}`);
    defaultBranch = branch();
    await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).rejects.toMatchObject({ status: 409 });
    expect(git(github, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("refuses to publish metadata committed outside the checkpoint path", async () => {
    await enableGithubProjectCheckout(key, upstream);
    const checkpointSha = saveCheckpoint("Reserved file", ".files/manifest.json");
    await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).rejects.toThrow("reserved asset manifest");
    expect(git(checkpoint, "rev-parse", branch())).toBe(checkpointSha);
    expect(git(github, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("refuses a diverged GitHub branch and keeps both heads", async () => {
    await enableGithubProjectCheckout(key, upstream);
    const checkpointSha = saveCheckpoint("Private version");
    const remoteSha = saveCheckpoint("Separate GitHub version", "README.md", github);
    await expect(publishGithubProject(key, project.repoSource, "Update Orbit")).rejects.toThrow("Both versions have been retained");
    expect(git(checkpoint, "rev-parse", branch())).toBe(checkpointSha);
    expect(git(github, "rev-parse", branch())).toBe(remoteSha);
    expect(pull).toBeNull();
  });
});
