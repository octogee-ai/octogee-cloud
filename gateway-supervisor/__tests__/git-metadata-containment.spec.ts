import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: `/tmp/octogee-metadata-containment-${process.pid}` }));
vi.mock("../lib/config.js", () => ({
  log: vi.fn(), dlog: vi.fn(), GIT_API_URL: "https://gitea.test/api/v1", GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: paths.root, CUSTOMERS_DIR: `${paths.root}/customers`,
  CUSTOMER_KEYS_DIR: `${paths.root}/keys`, AGENTS_DIR: `${paths.root}/agents`,
}));
const { externalizeUserGitDir, gitExec } = await import("../lib/git.js");
const repo = path.join(paths.root, "customers", "alice");
const metadata = path.join(paths.root, "git-metadata", "alice", "workspace.git");

function git(args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

beforeEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
  externalizeUserGitDir(repo, { fetchCanonical: () => {} });
  fs.writeFileSync(path.join(repo, "README.md"), "unpublished\n");
  git(["add", "."]);
  git(["commit", "-m", "unpublished"]);
});
afterEach(() => fs.rmSync(paths.root, { recursive: true, force: true }));

describe("provisioner Git metadata containment", () => {
  it.each(["refs/heads", "refs/heads/main", "objects/fanout"])("refuses carried %s links without rebuilding or changing them", (entry) => {
    const relative = entry === "objects/fanout"
      ? `objects/${fs.readdirSync(path.join(metadata, "objects")).find((name) => /^[0-9a-f]{2}$/u.test(name))}`
      : entry;
    const linked = path.join(metadata, relative);
    const original = path.join(paths.root, "retained-metadata");
    fs.renameSync(linked, original);
    fs.symlinkSync(original, linked);
    const index = fs.readFileSync(path.join(metadata, "index"));
    const fetchCanonical = vi.fn();

    expect(gitExec(repo, ["log", "--oneline"])).toBeNull();
    expect(() => externalizeUserGitDir(repo, { fetchCanonical })).toThrow("unsafe user Git metadata");
    expect(fetchCanonical).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(metadata, "index"))).toEqual(index);
    expect(fs.readlinkSync(linked)).toBe(original);
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("unpublished\n");
  });

  it.each(["commondir", "objects/info/alternates", "objects/info/http-alternates"])("refuses carried %s indirection", (entry) => {
    fs.mkdirSync(path.dirname(path.join(metadata, entry)), { recursive: true });
    fs.writeFileSync(path.join(metadata, entry), `${metadata}\n`);
    expect(gitExec(repo, ["log", "--oneline"])).toBeNull();
    expect(() => externalizeUserGitDir(repo)).toThrow("unsafe user Git metadata");
  });

  it("preserves unpublished commits, stash, branch, index and working files", () => {
    git(["checkout", "-b", "local-work"]);
    fs.appendFileSync(path.join(repo, "README.md"), "stash\n");
    git(["stash", "push", "-m", "local stash"]);
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    git(["add", "staged.txt"]);
    fs.appendFileSync(path.join(repo, "README.md"), "unstaged\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    const before = {
      refs: git(["show-ref"]), status: git(["status", "--porcelain"]),
      index: fs.readFileSync(path.join(metadata, "index")), branch: git(["branch", "--show-current"]),
    };
    const fetchCanonical = vi.fn();

    expect(externalizeUserGitDir(repo, { fetchCanonical })).toBe(metadata);
    expect(gitExec(repo, ["log", "--oneline"])).toContain("unpublished");
    expect(fetchCanonical).not.toHaveBeenCalled();
    expect(git(["show-ref"])).toBe(before.refs);
    expect(git(["branch", "--show-current"])).toBe(before.branch);
    expect(fs.readFileSync(path.join(metadata, "index"))).toEqual(before.index);
    expect(git(["status", "--porcelain"])).toBe(before.status);
  });
});
