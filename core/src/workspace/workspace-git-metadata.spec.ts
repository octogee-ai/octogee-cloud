import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitLog, gitStatus } from "./workspace-git.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

describe("self-contained user Git metadata", () => {
  let root: string;
  let repo: string;
  let metadata: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-metadata-containment-"));
    repo = path.join(root, "customers", "alice");
    metadata = path.join(root, "git-metadata", "alice", "workspace.git");
    vi.stubEnv("CUSTOMERS_DIR", path.join(root, "customers"));
    vi.stubEnv("GIT_SSH_HOST", "gitea");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@octogee.test"]);
    git(repo, ["remote", "add", "origin", "git@gitea:alice/workspace.git"]);
    fs.writeFileSync(path.join(repo, "README.md"), "local work\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "unpublished work"]);
    fs.mkdirSync(path.dirname(metadata), { recursive: true });
    fs.renameSync(path.join(repo, ".git"), metadata);
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${metadata}\n`);
    fs.writeFileSync(`${metadata}.octogee-trusted-v3`, "octogee-customer-git-v3\ngitea:workspace\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["refs/heads", "refs/heads/main", "objects/fanout"])(
    "refuses %s symlinks before reading repository history",
    async (entry) => {
      const relative = entry === "objects/fanout"
        ? `objects/${fs.readdirSync(path.join(metadata, "objects")).find((name) => /^[0-9a-f]{2}$/u.test(name))}`
        : entry;
      const original = path.join(metadata, relative);
      const outside = path.join(root, "outside-metadata");
      fs.renameSync(original, outside);
      fs.symlinkSync(outside, original);

      const result = await gitLog(repo);

      expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL", message: expect.stringContaining("unsafe-metadata") } });
      expect(fs.lstatSync(original).isSymbolicLink()).toBe(true);
    },
  );

  it("keeps local branches, staged changes and worktree changes readable", async () => {
    git(repo, ["checkout", "-b", "local-work"]);
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);
    fs.appendFileSync(path.join(repo, "README.md"), "unstaged\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    const before = {
      head: git(repo, ["rev-parse", "HEAD"]),
      branch: git(repo, ["branch", "--show-current"]),
      index: fs.readFileSync(path.join(metadata, "index")),
      status: git(repo, ["status", "--porcelain=v1"]),
    };

    expect(await gitLog(repo)).toMatchObject({ ok: true });
    expect(await gitStatus(repo)).toMatchObject({ ok: true });
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(repo, ["branch", "--show-current"])).toBe(before.branch);
    expect(fs.readFileSync(path.join(metadata, "index"))).toEqual(before.index);
    expect(git(repo, ["status", "--porcelain=v1"])).toBe(before.status);
  });
});
