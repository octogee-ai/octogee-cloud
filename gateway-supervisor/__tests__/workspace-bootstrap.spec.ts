import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-workspace-bootstrap-"));
const CUSTOMERS_DIR = path.join(TEST_ROOT, "customers");
afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

vi.mock("../lib/config.js", () => ({
  log: () => {},
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: TEST_ROOT,
  CUSTOMERS_DIR,
  CUSTOMER_KEYS_DIR: path.join(TEST_ROOT, "keys"),
  AGENTS_DIR: path.join(TEST_ROOT, "agents"),
}));

const { externalizeUserGitDir, initWorkspaceRepo } = await import("../lib/git.js");

function git(cwd: string, argv: string[]): string {
  return execFileSync("/usr/bin/git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

describe("fresh workspace bootstrap", () => {
  let remoteRoot: string;

  function prepareFrom(remote: string) {
    return (repoDir: string) => {
      externalizeUserGitDir(repoDir, {
        fetchCanonical: (_workTree, gitDir) => {
          git(gitDir, [
            "--git-dir",
            gitDir,
            "fetch",
            remote,
            "+refs/heads/*:refs/remotes/origin/*",
          ]);
        },
      });
    };
  }

  beforeEach(() => {
    fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });
    remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-workspace-remote-"));
  });

  afterEach(() => {
    for (const entry of fs.readdirSync(TEST_ROOT)) fs.rmSync(path.join(TEST_ROOT, entry), { recursive: true, force: true });
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  });

  it("pushes the initial skeleton before replacing local metadata with a canonical fetch", async () => {
    const slug = "aug09";
    const defaultAgentDir = path.join(CUSTOMERS_DIR, slug);
    const remote = path.join(remoteRoot, "workspace.git");
    fs.mkdirSync(defaultAgentDir, { recursive: true });
    git(remoteRoot, ["init", "--bare", "--initial-branch=main", remote]);

    const result = await initWorkspaceRepo(defaultAgentDir, slug, {
      ensureWorkspaceRepo: async () => {},
      workspaceRemoteUrl: () => remote,
      prepareRepository: prepareFrom(remote),
    });

    expect(result).not.toBeNull();
    expect(git(remote, ["--git-dir", remote, "log", "-1", "--format=%s"]))
      .toBe("initial workspace skeleton");
    expect(fs.readFileSync(path.join(defaultAgentDir, ".git"), "utf8"))
      .toBe(`gitdir: ${path.join(TEST_ROOT, "git-metadata", slug, "workspace.git")}\n`);
  });

  it("leaves an unreachable canonical repository retryable without partial metadata", async () => {
    const slug = "aug09";
    const defaultAgentDir = path.join(CUSTOMERS_DIR, slug);
    const remote = path.join(remoteRoot, "workspace.git");
    fs.mkdirSync(defaultAgentDir, { recursive: true });
    const deps = {
      ensureWorkspaceRepo: async () => {},
      workspaceRemoteUrl: () => remote,
      prepareRepository: prepareFrom(remote),
    };

    await expect(initWorkspaceRepo(defaultAgentDir, slug, deps)).resolves.toBeNull();
    expect(fs.existsSync(path.join(TEST_ROOT, "git-metadata", slug, "workspace.git")))
      .toBe(false);

    const welcomePath = path.join(defaultAgentDir, "notes", "welcome.md");
    fs.writeFileSync(welcomePath, "my existing note\n");
    git(remoteRoot, ["init", "--bare", "--initial-branch=main", remote]);
    await expect(initWorkspaceRepo(defaultAgentDir, slug, deps)).resolves.not.toBeNull();
    expect(fs.readFileSync(welcomePath, "utf8")).toBe("my existing note\n");
    expect(git(remote, ["--git-dir", remote, "log", "-1", "--format=%s"]))
      .toBe("initial workspace skeleton");
  });
});
