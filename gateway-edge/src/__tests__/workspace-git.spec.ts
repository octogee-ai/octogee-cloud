import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  gitBranches,
  gitCheckout,
  gitCommit,
  commitAndPushWorkspace,
  gitDiff,
  gitLog,
  gitPush,
  gitStatus,
  syncCleanWorkspaceToRemote,
  parseLog,
  parsePorcelain,
  resolveProjectDir,
  resolveUserDir,
  workspaceGitCommandArgs,
  workspaceGitEnvironment,
} from "../lib/workspace-git.js";

const NUL = String.fromCharCode(0x00);
const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-"));
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

describe("parsePorcelain", () => {
  it("returns [] for empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
  });

  it("parses a single modified file", () => {
    expect(parsePorcelain(` M README.md${NUL}`)).toEqual([
      { path: "README.md", change: "modified" },
    ]);
  });

  it("parses untracked + added + deleted + modified mixed", () => {
    const stdout =
      `?? newfile.ts${NUL}` +
      ` M README.md${NUL}` +
      `A  staged.ts${NUL}` +
      ` D removed.ts${NUL}`;
    expect(parsePorcelain(stdout)).toEqual([
      { path: "newfile.ts", change: "untracked" },
      { path: "README.md", change: "modified" },
      { path: "staged.ts", change: "added" },
      { path: "removed.ts", change: "deleted" },
    ]);
  });

  it("collapses a renamed pair into one entry on the new path", () => {
    
    const stdout =
      `R  newname.ts${NUL}oldname.ts${NUL}` +
      ` M other.ts${NUL}`;
    expect(parsePorcelain(stdout)).toEqual([
      { path: "newname.ts", change: "renamed" },
      { path: "other.ts", change: "modified" },
    ]);
  });

  it("collapses a copy (C) record's old-path companion the same way as rename (P1-5)", () => {
    const stdout =
      `C  copied.ts${NUL}original.ts${NUL}` +
      ` M unrelated.ts${NUL}`;
    expect(parsePorcelain(stdout)).toEqual([
      { path: "copied.ts", change: "renamed" },
      { path: "unrelated.ts", change: "modified" },
    ]);
  });
});

describe("parseLog", () => {
  it("returns [] for empty input", () => {
    expect(parseLog("")).toEqual([]);
  });

  it("parses sha, author, ts, subject from one record", () => {
    const stdout = `abc123${US}Alice${US}1730000000${US}Initial${RS}`;
    expect(parseLog(stdout)).toEqual([
      { sha: "abc123", author: "Alice", ts: 1730000000, subject: "Initial" },
    ]);
  });

  it("parses multiple records in order", () => {
    const stdout =
      `sha2${US}Bob${US}1730000200${US}second${RS}` +
      `sha1${US}Alice${US}1730000100${US}first${RS}`;
    expect(parseLog(stdout)).toEqual([
      { sha: "sha2", author: "Bob", ts: 1730000200, subject: "second" },
      { sha: "sha1", author: "Alice", ts: 1730000100, subject: "first" },
    ]);
  });

  it("skips records with non-numeric timestamps (defensive)", () => {
    const stdout =
      `sha${US}name${US}not-a-number${US}subj${RS}` +
      `ok${US}A${US}1730000000${US}good${RS}`;
    expect(parseLog(stdout)).toEqual([
      { sha: "ok", author: "A", ts: 1730000000, subject: "good" },
    ]);
  });
});

describe("resolveUserDir", () => {
  let repo: string;
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wsroot-"));
    const slugDir = path.join(root, "alice");
    await fs.mkdir(slugDir);
    spawnSync("git", ["init", slugDir]);
    repo = slugDir;
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the dir when it exists and contains .git", async () => {
    expect(await resolveUserDir(root, "alice")).toBe(repo);
  });

  it("returns null for a missing slug dir", async () => {
    expect(await resolveUserDir(root, "nope")).toBeNull();
  });

  it("rejects a symlink in a customer or project checkout path", async () => {
    await fs.symlink(repo, path.join(root, "linked"), "dir");
    expect(await resolveUserDir(root, "linked")).toBeNull();

    const project = path.join(root, "project");
    await fs.mkdir(path.join(project, "demo", ".git"), { recursive: true });
    await fs.symlink(project, path.join(repo, "projects"), "dir");
    expect(await resolveProjectDir(root, "alice", "demo")).toBeNull();
  });

  it("rejects a checkout with symlinked Git metadata", async () => {
    const checkout = path.join(root, "metadata-link");
    await fs.mkdir(checkout);
    await fs.symlink(path.join(repo, ".git"), path.join(checkout, ".git"), "dir");
    expect(await resolveUserDir(root, "metadata-link")).toBeNull();
  });

  it("returns null when the dir lacks .git (not a working tree)", async () => {
    const slugDir = path.join(root, "no-git");
    await fs.mkdir(slugDir);
    expect(await resolveUserDir(root, "no-git")).toBeNull();
  });

  it("rejects slugs containing path-traversal segments", async () => {
    expect(await resolveUserDir(root, "..")).toBeNull();
    expect(await resolveUserDir(root, "alice/..")).toBeNull();
    expect(await resolveUserDir(root, "../etc/passwd")).toBeNull();
  });

  it("rejects bare-dot, empty, leading-dash, oversize slugs (#841 review allowlist)", async () => {
    expect(await resolveUserDir(root, ".")).toBeNull();
    expect(await resolveUserDir(root, "")).toBeNull();
    expect(await resolveUserDir(root, "-evil")).toBeNull();
    expect(await resolveUserDir(root, "a".repeat(64))).toBeNull();
    expect(await resolveUserDir(root, " alice")).toBeNull();
  });
});

describe("gitStatus / gitDiff / gitLog (real git)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await makeRepo();
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("status: clean tree is empty", async () => {
    const r = await gitStatus(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([]);
  });

  it("status: single modified file shows up correctly", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "changed\n");
    const r = await gitStatus(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toEqual([{ path: "README.md", change: "modified" }]);
  });

  it("diff: returns non-empty unified diff for a modified file", async () => {
    const r = await gitDiff(repo, { path: "README.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff).toContain("--- a/README.md");
    expect(r.diff).toContain("+changed");
  });

  it("log: returns one entry for the initial commit", async () => {
    const r = await gitLog(repo, { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].subject).toBe("initial");
    expect(r.entries[0].author).toBe("test");
    expect(r.entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.entries[0].ts).toBeGreaterThan(0);
  });

  it("status: NOT_A_REPO error when called against a non-git dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noregit-"));
    try {
      const r = await gitStatus(dir);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_A_REPO");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("hardening: user-controlled diff.external in .git/config fails closed", async () => {

const canary = path.join(repo, ".pwned-canary");
    const driver = path.join(repo, "evil-driver.sh");
    await fs.writeFile(driver, `#!/bin/sh\ntouch "${canary}"\n`);
    await fs.chmod(driver, 0o755);
    git(repo, ["config", "diff.external", driver]);

    await fs.writeFile(path.join(repo, "README.md"), "trigger diff\n");
    const r = await gitDiff(repo, { path: "README.md" });
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL" } });

await expect(fs.access(canary)).rejects.toThrow();

git(repo, ["config", "--unset", "diff.external"]);
    await fs.rm(driver, { force: true });
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  });

  it("hardening: clean-filter config is rejected before staging can execute it", async () => {
    const canary = path.join(repo, ".filter-canary");
    git(repo, ["config", "filter.octogee-test.clean", `touch ${canary}; cat`]);
    await fs.writeFile(path.join(repo, ".gitattributes"), "payload.txt filter=octogee-test\n");
    await fs.writeFile(path.join(repo, "payload.txt"), "payload\n");

    const r = await gitCommit(repo, {
      message: "must not execute",
      author: { name: "Owner", email: "owner@example.com" },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await expect(fs.access(canary)).rejects.toThrow();

    git(repo, ["config", "--unset", "filter.octogee-test.clean"]);
    await fs.rm(path.join(repo, ".gitattributes"), { force: true });
    await fs.rm(path.join(repo, "payload.txt"), { force: true });
  });
});

describe("platform-owned user Git metadata", () => {
  it.each(["prepare", "divert"])("rechecks custody after awaited %s work before its next Git effect", async phase => {
    let current = true;
    const release = vi.fn();
    const gitCommit = vi.fn(async () => ({ ok: true as const, result: { sha: "local", empty: false } }));
    const gitPush = vi.fn(async () => ({ ok: true as const }));
    const save = commitAndPushWorkspace("/private/synthetic/user", {
      message: "checkpoint", author: { name: "Alice", email: "alice@example.test" },
      beforeCommit: async () => { if (phase === "divert") { current = false; } return { ok: true }; },
      assertCurrent: async () => { if (!current) throw new Error("custody changed"); },
    }, {
      acquireMutationLease: () => ({ release }) as never,
      gitCommit, gitPush,
      gitPreparePush: async () => { current = false; return { ok: true, target: { branch: "main", setUpstream: false } }; },
    });
    await expect(save).rejects.toThrow("custody changed");
    expect(gitCommit).toHaveBeenCalledTimes(phase === "divert" ? 0 : 1);
    expect(gitPush).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it("never inherits the user's ambient GitHub credential", async () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    const previousGatewayClass = process.env.GATEWAY_CLASS;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-user-github-"));
    const usersRoot = path.join(root, "customers");
    const projectDir = path.join(usersRoot, "alice", "projects", "orbit");
    const metadataDir = path.join(root, "git-metadata", "alice", "projects", "orbit.git");
    process.env.CUSTOMERS_DIR = usersRoot;
    process.env.GATEWAY_CLASS = "isolated";
    try {
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(metadataDir, { recursive: true });
      await fs.writeFile(
        `${metadataDir}.octogee-trusted-v3`,
        "octogee-customer-git-v3\ngithub:octogee-ai/orbit\n",
      );

      const args = workspaceGitCommandArgs(projectDir, ["push"]);
      const env = workspaceGitEnvironment(
        { GATEWAY_CLASS: "isolated", GIT_CONFIG_GLOBAL: "/home/node/.gitconfig" },
        projectDir,
      );

      expect(args).toContain("credential.helper=");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");

      process.env.GATEWAY_CLASS = "shared";
      expect(workspaceGitCommandArgs(projectDir, ["push"])).toContain("credential.helper=");
      expect(workspaceGitEnvironment({ GATEWAY_CLASS: "shared" }, projectDir).GIT_CONFIG_GLOBAL)
        .toBe("/dev/null");
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
      if (previousGatewayClass === undefined) delete process.env.GATEWAY_CLASS;
      else process.env.GATEWAY_CLASS = previousGatewayClass;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates an explicit caller GitHub credential from the user's ambient credential", async () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    const previousGatewayClass = process.env.GATEWAY_CLASS;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-caller-github-"));
    const usersRoot = path.join(root, "customers");
    const projectDir = path.join(usersRoot, "alice", "projects", "orbit");
    const metadataDir = path.join(root, "git-metadata", "alice", "projects", "orbit.git");
    process.env.CUSTOMERS_DIR = usersRoot;
    process.env.GATEWAY_CLASS = "isolated";
    try {
      await fs.mkdir(projectDir, { recursive: true });
      await fs.mkdir(metadataDir, { recursive: true });
      await fs.writeFile(
        `${metadataDir}.octogee-trusted-v3`,
        "octogee-customer-git-v3\ngithub:octogee-ai/orbit\n",
      );

      const args = workspaceGitCommandArgs(projectDir, ["push"], true);
      const env = workspaceGitEnvironment(
        {
          GATEWAY_CLASS: "isolated",
          GIT_CONFIG_GLOBAL: "/home/node/.gitconfig",
          GH_TOKEN: "ambient-gh-token",
          GITHUB_TOKEN: "ambient-github-token",
          GIT_CONFIG: "/tmp/ambient-config",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_PARAMETERS: "'credential.helper=!leak'",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "!leak",
        },
        projectDir,
        "gh-member-token",
      );

      expect(args).toContain("credential.helper=");
      expect(args.join(" ")).toContain("OCTOGEE_GITHUB_TOKEN");
      expect(args.join(" ")).not.toContain("gh-member-token");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(env.OCTOGEE_GITHUB_TOKEN).toBe("gh-member-token");
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.GIT_CONFIG).toBeUndefined();
      expect(env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
      if (previousGatewayClass === undefined) delete process.env.GATEWAY_CLASS;
      else process.env.GATEWAY_CLASS = previousGatewayClass;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("pins workspace and project SSH to the owning user's platform key", () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    process.env.CUSTOMERS_DIR = "/srv/openclaw/customers";
    try {
      const workspaceEnv = workspaceGitEnvironment({}, "/srv/openclaw/customers/mike");
      const projectEnv = workspaceGitEnvironment(
        {},
        "/srv/openclaw/customers/mike/projects/garden",
      );
      expect(workspaceEnv.GIT_SSH_COMMAND).toContain(
        '"/srv/openclaw/customer-keys/mike/id_ed25519"',
      );
      expect(projectEnv.GIT_SSH_COMMAND).toContain(
        '"/srv/openclaw/customer-keys/mike/id_ed25519"',
      );
      expect(projectEnv.GIT_SSH_COMMAND).not.toContain("garden/id_ed25519");
      expect(projectEnv.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
    }
  });

  it("passes the external metadata directory to the workspace mutation lease", async () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-lease-"));
    const usersRoot = path.join(root, "customers");
    const customerDir = path.join(usersRoot, "alice");
    process.env.CUSTOMERS_DIR = usersRoot;
    const release = vi.fn();
    const acquireMutationLease = vi.fn(() => ({ release }));
    try {
      const result = await commitAndPushWorkspace(
        customerDir,
        { message: "checkpoint", author: { name: "Owner", email: "owner@example.com" } },
        {
          acquireMutationLease,
          gitCommit: vi.fn(async () => ({ ok: true as const, result: { sha: "", empty: true } })),
          gitPreparePush: vi.fn(async () => ({
            ok: true as const,
            target: { branch: "main", setUpstream: false },
          })),
          gitPush: vi.fn(async () => ({ ok: true as const })),
        },
      );

      expect(result).toMatchObject({ ok: true, result: { pushed: true } });
      expect(acquireMutationLease).toHaveBeenCalledWith({
        workspaceDir: customerDir,
        gitDir: path.join(root, "git-metadata", "alice", "workspace.git"),
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the canonical main upstream in platform-owned project metadata", async () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-canonical-upstream-"));
    const usersRoot = path.join(root, "customers");
    const repo = path.join(usersRoot, "alice", "projects", "orbit");
    const trustedGitDir = path.join(root, "git-metadata", "alice", "projects", "orbit.git");
    const configPath = path.join(trustedGitDir, "config");
    process.env.CUSTOMERS_DIR = usersRoot;
    try {
      await fs.mkdir(repo, { recursive: true });
      git(repo, ["init", "--initial-branch=main"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "test"]);
      await fs.writeFile(path.join(repo, "README.md"), "hello\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "initial"]);
      git(repo, ["remote", "add", "origin", "git@gitea:alice/orbit.git"]);
      git(repo, ["config", "branch.main.remote", "origin"]);
      git(repo, ["config", "branch.main.merge", "refs/heads/main"]);
      await fs.mkdir(path.dirname(trustedGitDir), { recursive: true });
      await fs.rename(path.join(repo, ".git"), trustedGitDir);
      await fs.writeFile(
        `${trustedGitDir}.octogee-trusted-v3`,
        "octogee-customer-git-v3\ngitea:orbit\n",
      );
      await fs.writeFile(path.join(repo, ".git"), `gitdir: ${trustedGitDir}\n`);

      await expect(gitStatus(repo)).resolves.toEqual({ ok: true, entries: [] });

      git(repo, ["config", "--file", configPath, "branch.main.remote", "elsewhere"]);
      await expect(gitStatus(repo)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL",
          message: expect.stringContaining("branch.main.remote"),
        },
      });

      git(repo, ["config", "--file", configPath, "branch.main.remote", "origin"]);
      git(repo, ["config", "--file", configPath, "--unset-all", "branch.main.merge"]);
      await expect(gitStatus(repo)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL",
          message: expect.stringContaining("branch.main"),
        },
      });

      git(repo, [
        "config",
        "--file",
        configPath,
        "branch.main.merge",
        "refs/heads/main",
      ]);
      git(repo, ["config", "--file", configPath, "branch.preview.remote", "origin"]);
      await expect(gitStatus(repo)).resolves.toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL",
          message: expect.stringContaining("branch.preview.remote"),
        },
      });
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not prepare a commit while the workspace mutation lease is held", async () => {
    const customerDir = await makeRepo();
    const beforeCommit = vi.fn(async () => ({ ok: true as const }));
    const result = await commitAndPushWorkspace(
      customerDir,
      {
        message: "checkpoint",
        author: { name: "Owner", email: "owner@example.com" },
        beforeCommit,
      },
      {
        acquireMutationLease: vi.fn(() => null),
        gitCommit: vi.fn(),
        gitPreparePush: vi.fn(),
        gitPush: vi.fn(),
      },
    );

    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_BUSY", cwd: customerDir } });
    expect(beforeCommit).not.toHaveBeenCalled();
  });

  it("ignores an agent-controlled .git pointer while staging workspace files", async () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-external-"));
    const usersRoot = path.join(root, "customers");
    const repo = path.join(usersRoot, "alice");
    const trustedGitDir = path.join(root, "git-metadata", "alice", "workspace.git");
    const attacker = path.join(root, "attacker");
    process.env.CUSTOMERS_DIR = usersRoot;
    try {
      await fs.mkdir(repo, { recursive: true });
      git(repo, ["init", "--initial-branch=main"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "test"]);
      await fs.writeFile(path.join(repo, "README.md"), "hello\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "initial"]);
      git(repo, ["remote", "add", "origin", "git@gitea:alice/workspace.git"]);
      await fs.mkdir(path.dirname(trustedGitDir), { recursive: true });
      await fs.rename(path.join(repo, ".git"), trustedGitDir);
      await fs.writeFile(
        `${trustedGitDir}.octogee-trusted-v3`,
        "octogee-customer-git-v3\ngitea:workspace\n",
      );

      await fs.mkdir(attacker);
      git(attacker, ["init"]);
      const marker = path.join(root, "filter-ran");
      git(attacker, ["config", "filter.octogee-test.clean", `touch ${marker}; cat`]);
      await fs.writeFile(path.join(repo, ".git"), `gitdir: ${path.join(attacker, ".git")}\n`);
      await fs.writeFile(path.join(repo, ".gitattributes"), "payload.txt filter=octogee-test\n");
      await fs.writeFile(path.join(repo, "payload.txt"), "payload\n");

      const result = await gitCommit(repo, {
        message: "platform metadata only",
        author: { name: "Owner", email: "owner@example.com" },
      });
      expect(result).toMatchObject({ ok: true, result: { empty: false } });
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe clean filter in platform-owned project metadata before staging", async () => {
    const previousUsersDir = process.env.CUSTOMERS_DIR;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wsgit-project-filter-"));
    const usersRoot = path.join(root, "customers");
    const repo = path.join(usersRoot, "alice", "projects", "orbit");
    const trustedGitDir = path.join(root, "git-metadata", "alice", "projects", "orbit.git");
    const marker = path.join(root, "project-filter-ran");
    process.env.CUSTOMERS_DIR = usersRoot;
    try {
      await fs.mkdir(repo, { recursive: true });
      git(repo, ["init", "--initial-branch=main"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "test"]);
      await fs.writeFile(path.join(repo, "README.md"), "hello\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "initial"]);
      git(repo, ["remote", "add", "origin", "git@gitea:alice/orbit.git"]);
      git(repo, ["config", "filter.octogee-test.clean", `touch ${marker}; cat`]);
      await fs.mkdir(path.dirname(trustedGitDir), { recursive: true });
      await fs.rename(path.join(repo, ".git"), trustedGitDir);
      await fs.writeFile(`${trustedGitDir}.octogee-trusted-v2`, "octogee-user-git-v2\n");
      await fs.writeFile(path.join(repo, ".gitattributes"), "payload.txt filter=octogee-test\n");
      await fs.writeFile(path.join(repo, "payload.txt"), "payload\n");

      const result = await gitCommit(repo, {
        message: "must not execute project filter",
        author: { name: "Owner", email: "owner@example.com" },
      });

      expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      if (previousUsersDir === undefined) delete process.env.CUSTOMERS_DIR;
      else process.env.CUSTOMERS_DIR = previousUsersDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("gitCommit (Phase 6.C.2)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "wscommit-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "agent@octogee.local"]);
    git(repo, ["config", "user.name", "agent"]);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    await fs.writeFile(path.join(repo, ".gitignore"), "projects/\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("commits modified working tree with workspace owner author override (transient -c flags)", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "changed\n");
    const r = await gitCommit(repo, {
      message: "Owner-driven change",
      author: { name: "Bob Owner", email: "bob@example.com" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.empty).toBe(false);
    expect(r.result.sha).toMatch(/^[0-9a-f]{40}$/);

const cfg = spawnSync("git", ["config", "user.email"], { cwd: repo, encoding: "utf-8" });
    expect(cfg.stdout.trim()).toBe("agent@octogee.local");
    
    const last = spawnSync("git", ["log", "-1", "--pretty=format:%ae"], {
      cwd: repo,
      encoding: "utf-8",
    });
    expect(last.stdout.trim()).toBe("bob@example.com");
  });

  it("returns empty: true when nothing is staged (clean tree commit is a no-op)", async () => {
    const r = await gitCommit(repo, {
      message: "nothing to commit",
      author: { name: "Bob", email: "b@x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.empty).toBe(true);
    expect(r.result.sha).toBe("");
  });

  it("rejects empty / whitespace-only commit messages", async () => {
    const r = await gitCommit(repo, {
      message: "   ",
      author: { name: "Bob", email: "b@x" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects pathologically long commit messages (>5000 chars)", async () => {
    const r = await gitCommit(repo, {
      message: "x".repeat(5_001),
      author: { name: "Bob", email: "b@x" },
    });
    expect(r.ok).toBe(false);
  });

  it("captures all working-tree changes (added + modified + deleted) in one commit", async () => {
    await fs.writeFile(path.join(repo, "newfile.ts"), "new\n");
    await fs.writeFile(path.join(repo, "README.md"), "modified again\n");
    const r = await gitCommit(repo, {
      message: "multi",
      author: { name: "Bob", email: "b@x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.empty).toBe(false);

    const status = await gitStatus(repo);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.entries).toEqual([]);
  });

  it("commits the workspace lane while .gitignore keeps nested project clones out", async () => {
    const projectDir = path.join(repo, "projects", "blog");
    await fs.mkdir(projectDir, { recursive: true });
    git(projectDir, ["init", "--initial-branch=main"]);
    await fs.writeFile(path.join(projectDir, "index.html"), "<h1>hi</h1>\n");
    await fs.writeFile(path.join(repo, "notes.md"), "workspace change\n");

    const r = await gitCommit(repo, {
      message: "workspace lane",
      author: { name: "Bob", email: "b@x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.empty).toBe(false);

    const tracked = spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf-8" });
    expect(tracked.stdout).toContain("notes.md");
    expect(tracked.stdout).not.toContain("projects/blog");

    const ignored = spawnSync("git", ["check-ignore", "projects"], { cwd: repo });
    expect(ignored.status).toBe(0);
  });
});

describe("gitPush (Phase 6.C.2)", () => {

let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "wspush-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns GIT_FAILED when no `origin` remote is configured (helper surfaces git's error structurally)", async () => {
    const r = await gitPush(repo);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("GIT_FAILED");
  });

  it("returns NOT_A_REPO when called against a non-git dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noregit-push-"));
    try {
      const r = await gitPush(dir);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_A_REPO");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("--end-of-options keeps a `-`-prefixed branch from being parsed as a flag (no remote-spec injection)", async () => {

const r = await gitPush(repo, { branch: "-deletes-everything" });
    expect(r.ok).toBe(false);
    if (r.ok) return;

expect(r.error.code).toMatch(/GIT_FAILED|NOT_A_REPO/);
  });

  it("hardening: user-controlled `protocol.ext.allow=always` does NOT enable ext::-as-exec on push (#839 Copilot P0)", async () => {

const canary = path.join(repo, ".pwned-via-ext-canary");
    git(repo, ["config", "protocol.ext.allow", "always"]);
    git(repo, ["remote", "add", "evil", `ext::sh -c "touch ${canary}; exit 1"`]);
    try {

git(repo, ["remote", "rename", "evil", "origin"]);
      const r = await gitPush(repo);
      expect(r.ok).toBe(false);
      if (r.ok) return;

await expect(fs.access(canary)).rejects.toThrow();
    } finally {

try { git(repo, ["remote", "remove", "origin"]); } catch { /* ok */ }
      try { git(repo, ["config", "--unset", "protocol.ext.allow"]); } catch { /* ok */ }
      await fs.rm(canary, { force: true });
    }
  });
});

describe("commitAndPushWorkspace remote convergence", () => {
  it("converges Canvas races, publishes a new branch, and aborts conflicts safely", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-converge-"));
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const agent = path.join(root, "agent");
    const canvas = path.join(root, "canvas");
    const testSsh = path.join(root, "test-ssh");
    const originalGitSsh = process.env.GIT_SSH;
    await fs.mkdir(seed);
    git(root, ["init", "--bare", "--initial-branch=main", remote]);
    git(remote, ["config", "maintenance.autoDetach", "false"]);
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "maintenance.autoDetach", "false"]);
    git(seed, ["config", "user.email", "seed@example.com"]);
    git(seed, ["config", "user.name", "seed"]);
    await fs.writeFile(path.join(seed, "README.md"), "seed\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    git(root, ["clone", "--config", "maintenance.autoDetach=false", remote, agent]);
    git(root, ["clone", "--config", "maintenance.autoDetach=false", remote, canvas]);
    await fs.writeFile(testSsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");
    await fs.chmod(testSsh, 0o755);
    git(agent, ["remote", "set-url", "origin", `ssh://git@localhost${remote}`]);
    process.env.GIT_SSH = testSsh;

    try {
      git(canvas, ["config", "user.email", "canvas@example.com"]);
      git(canvas, ["config", "user.name", "canvas"]);
      await fs.writeFile(path.join(canvas, "canvas.md"), "remote canvas\n");
      git(canvas, ["add", "."]);
      git(canvas, ["commit", "-m", "canvas update"]);
      git(canvas, ["push", "origin", "main"]);

      await fs.writeFile(path.join(agent, "agent.md"), "local agent\n");
      const result = await commitAndPushWorkspace(agent, {
        message: "agent update",
        author: { name: "Agent", email: "agent@octogee.local" },
      });

      expect(result).toEqual({
        ok: true,
        result: { committed: true, pushed: true, nothingToCommit: false },
      });
      const remoteFiles = spawnSync(
        "git",
        ["--git-dir", remote, "ls-tree", "--name-only", "-r", "main"],
        { encoding: "utf8" },
      );
      expect(remoteFiles.status, remoteFiles.stderr).toBe(0);
      expect(remoteFiles.stdout.trim().split("\n").sort()).toEqual([
        "README.md",
        "agent.md",
        "canvas.md",
      ]);

      expect(await gitCheckout(agent, { branch: "feature/agent-edit", create: true })).toEqual({
        ok: true,
      });
      await fs.writeFile(path.join(agent, "feature.md"), "branch edit\n");
      const branchResult = await commitAndPushWorkspace(agent, {
        message: "feature update",
        author: { name: "Agent", email: "agent@octogee.local" },
      });

      expect(branchResult).toEqual({
        ok: true,
        result: { committed: true, pushed: true, nothingToCommit: false },
      });
      const upstream = spawnSync(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { cwd: agent, encoding: "utf8" },
      );
      expect(upstream.status).not.toBe(0);
      const remoteBranchFile = spawnSync(
        "git",
        [
          "--git-dir",
          remote,
          "show",
          "refs/heads/feature/agent-edit:feature.md",
        ],
        { encoding: "utf8" },
      );
      expect(remoteBranchFile.status, remoteBranchFile.stderr).toBe(0);
      expect(remoteBranchFile.stdout).toBe("branch edit\n");

      expect(await gitCheckout(agent, { branch: "main" })).toEqual({ ok: true });
      git(canvas, ["pull", "--ff-only", "origin", "main"]);
      await fs.writeFile(path.join(canvas, "README.md"), "canvas conflict winner\n");
      git(canvas, ["add", "."]);
      git(canvas, ["commit", "-m", "canvas conflicting update"]);
      git(canvas, ["push", "origin", "main"]);
      await fs.writeFile(path.join(agent, "README.md"), "agent conflicting edit\n");

      const conflictResult = await commitAndPushWorkspace(agent, {
        message: "agent conflicting update",
        author: { name: "Agent", email: "agent@octogee.local" },
      });

      expect(conflictResult).toEqual({
        ok: true,
        result: {
          committed: true,
          pushed: false,
          nothingToCommit: false,
          pushError: "git failed (status 1)",
        },
      });
      const localSubject = spawnSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: agent,
        encoding: "utf8",
      });
      expect(localSubject.status, localSubject.stderr).toBe(0);
      expect(localSubject.stdout.trim()).toBe("agent conflicting update");
      const localStatus = spawnSync("git", ["status", "--porcelain"], {
        cwd: agent,
        encoding: "utf8",
      });
      expect(localStatus.status, localStatus.stderr).toBe(0);
      expect(localStatus.stdout).toBe("");
      const remoteMainReadme = spawnSync(
        "git",
        ["--git-dir", remote, "show", "refs/heads/main:README.md"],
        { encoding: "utf8" },
      );
      expect(remoteMainReadme.status, remoteMainReadme.stderr).toBe(0);
      expect(remoteMainReadme.stdout).toBe("canvas conflict winner\n");
    } finally {
      if (originalGitSsh === undefined) delete process.env.GIT_SSH;
      else process.env.GIT_SSH = originalGitSsh;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("syncCleanWorkspaceToRemote", () => {
  it("fast-forwards a clean agent checkout immediately after a Canvas commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-canvas-sync-"));
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const agent = path.join(root, "agent");
    const canvas = path.join(root, "canvas");
    const testSsh = path.join(root, "test-ssh");
    const originalGitSsh = process.env.GIT_SSH;
    await fs.mkdir(seed);
    git(root, ["init", "--bare", "--initial-branch=main", remote]);
    git(remote, ["config", "maintenance.autoDetach", "false"]);
    git(seed, ["init", "--initial-branch=main"]);
    git(seed, ["config", "maintenance.autoDetach", "false"]);
    git(seed, ["config", "user.email", "seed@example.com"]);
    git(seed, ["config", "user.name", "seed"]);
    await fs.writeFile(path.join(seed, "README.md"), "before Canvas\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "seed"]);
    git(seed, ["remote", "add", "origin", remote]);
    git(seed, ["push", "-u", "origin", "main"]);
    git(root, ["clone", "--config", "maintenance.autoDetach=false", remote, agent]);
    git(root, ["clone", "--config", "maintenance.autoDetach=false", remote, canvas]);
    await fs.writeFile(testSsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");
    await fs.chmod(testSsh, 0o755);
    git(agent, ["remote", "set-url", "origin", `ssh://git@localhost${remote}`]);
    process.env.GIT_SSH = testSsh;

    try {
      git(canvas, ["config", "user.email", "canvas@example.com"]);
      git(canvas, ["config", "user.name", "canvas"]);
      await fs.writeFile(path.join(canvas, "README.md"), "after Canvas\n");
      git(canvas, ["add", "."]);
      git(canvas, ["commit", "-m", "canvas update"]);
      git(canvas, ["push", "origin", "main"]);

      expect(await fs.readFile(path.join(agent, "README.md"), "utf8")).toBe("before Canvas\n");
      await expect(syncCleanWorkspaceToRemote(agent)).resolves.toEqual({
        ok: true,
        result: { state: "fast-forwarded" },
      });
      expect(await fs.readFile(path.join(agent, "README.md"), "utf8")).toBe("after Canvas\n");
    } finally {
      if (originalGitSsh === undefined) delete process.env.GIT_SSH;
      else process.env.GIT_SSH = originalGitSsh;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a dirty checkout untouched instead of overwriting agent work", async () => {
    const repo = await makeRepo();
    try {
      await fs.writeFile(path.join(repo, "README.md"), "uncommitted agent work\n");

      await expect(syncCleanWorkspaceToRemote(repo)).resolves.toEqual({
        ok: true,
        result: { state: "dirty" },
      });
      expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe(
        "uncommitted agent work\n",
      );
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("gitCommit hardening (Phase 6.C.2 — #839 Copilot P0)", () => {

let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "wshooks-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("user-controlled .git/hooks/pre-commit does not execute on owner commit", async () => {
    const canary = path.join(repo, ".pwned-via-hook-canary");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, `#!/bin/sh\ntouch "${canary}"\nexit 0\n`);
    await fs.chmod(hook, 0o755);
    await fs.writeFile(path.join(repo, "README.md"), "trigger commit\n");
    try {
      const r = await gitCommit(repo, {
        message: "trigger hook",
        author: { name: "Owner", email: "owner@example.com" },
      });
      expect(r.ok).toBe(true);

await expect(fs.access(canary)).rejects.toThrow();
    } finally {
      await fs.rm(hook, { force: true });
      await fs.rm(canary, { force: true });
      await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    }
  });

  it("user-controlled core.hooksPath in .git/config fails closed", async () => {

const canary = path.join(repo, ".pwned-via-hookspath-canary");
    const hooksDir = await fs.mkdtemp(path.join(os.tmpdir(), "evil-hooks-"));
    const hook = path.join(hooksDir, "pre-commit");
    await fs.writeFile(hook, `#!/bin/sh\ntouch "${canary}"\nexit 0\n`);
    await fs.chmod(hook, 0o755);
    git(repo, ["config", "core.hooksPath", hooksDir]);
    await fs.writeFile(path.join(repo, "README.md"), "trigger commit 2\n");
    try {
      const r = await gitCommit(repo, {
        message: "trigger hookspath",
        author: { name: "Owner", email: "owner@example.com" },
      });
      expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
      await expect(fs.access(canary)).rejects.toThrow();
    } finally {
      try { git(repo, ["config", "--unset", "core.hooksPath"]); } catch { /* ok */ }
      await fs.rm(hooksDir, { recursive: true, force: true });
      await fs.rm(canary, { force: true });
      await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    }
  });
});

describe("gitBranches (Phase 6.C.3)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "wsbranch-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["branch", "feat/work"]);
    git(repo, ["branch", "fix/bug"]);
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("lists local branches with the current one flagged", async () => {
    const r = await gitBranches(repo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(["feat/work", "fix/bug", "main"]);
    const current = r.entries.find((e) => e.current);
    expect(current?.name).toBe("main");
  });

  it("returns NOT_A_REPO when called against a non-git dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noregit-branches-"));
    try {
      const r = await gitBranches(dir);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("NOT_A_REPO");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gitCheckout (Phase 6.C.3)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "wscheckout-"));
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "t@t.t"]);
    git(repo, ["config", "user.name", "t"]);
    await fs.writeFile(path.join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["branch", "feat/work"]);
  });
  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("switches to an existing branch", async () => {
    const r = await gitCheckout(repo, { branch: "feat/work" });
    expect(r.ok).toBe(true);
    const branches = await gitBranches(repo);
    if (!branches.ok) throw new Error("branch list failed");
    expect(branches.entries.find((e) => e.current)?.name).toBe("feat/work");
    
    await gitCheckout(repo, { branch: "main" });
  });

  it("creates and switches to a new branch when create:true", async () => {
    const r = await gitCheckout(repo, { branch: "feat/new", create: true });
    expect(r.ok).toBe(true);
    const branches = await gitBranches(repo);
    if (!branches.ok) throw new Error("branch list failed");
    expect(branches.entries.find((e) => e.current)?.name).toBe("feat/new");
    await gitCheckout(repo, { branch: "main" });
  });

  it("returns GIT_FAILED when the target branch does not exist (no create)", async () => {
    const r = await gitCheckout(repo, { branch: "no-such-branch" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("GIT_FAILED");
  });

  it("rejects empty / pathologically-long branch names at the helper layer", async () => {
    const r1 = await gitCheckout(repo, { branch: "" });
    expect(r1.ok).toBe(false);
    const huge = "a".repeat(300);
    const r2 = await gitCheckout(repo, { branch: huge });
    expect(r2.ok).toBe(false);
  });

  it("rejects `-`-prefixed branch names at the helper layer (no flag-injection vector)", async () => {

const r = await gitCheckout(repo, { branch: "-deletes-everything" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INTERNAL");
  });
});
