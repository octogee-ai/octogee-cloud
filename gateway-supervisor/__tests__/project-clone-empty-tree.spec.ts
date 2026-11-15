import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

vi.mock("../lib/config.js", async () => {
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const root = nodePath.join(os.tmpdir(), `octogee-project-clone-${process.pid}`);
  return {
    log: () => {},
    dlog: () => {},
    GIT_API_URL: "https://gitea.test/api/v1",
    GIT_SSH_HOST: "gitea.test",
    OPENCLAW_DIR: root,
    CUSTOMERS_DIR: nodePath.join(root, "customers"),
    CUSTOMER_KEYS_DIR: nodePath.join(root, "keys"),
    AGENTS_DIR: nodePath.join(root, "agents"),
  };
});

vi.mock("../lib/gitea-admin-broker-client.js", () => ({
  brokeredGitHost: {
    repoExists: vi.fn(async () => true),
    registerKey: vi.fn(async () => {}),
    listKeys: vi.fn(async () => []),
    releaseKey: vi.fn(async () => {}),
    ensureOwner: vi.fn(async () => {}),
    ensureRepo: vi.fn(async () => {}),
    archiveRepo: vi.fn(async () => {}),
  },
}));

const { OPENCLAW_DIR, CUSTOMERS_DIR } = await import("../lib/config.js");
const { cloneProjectRepo, workspaceTreeState } = await import("../lib/git.js");

const SLUG = "walter";
const PROJECT = "tictactoe";
const TRACKED = {
  "AGENTS.md": "# AGENTS.md\nProject agent instructions.\n",
  "IDENTITY.md": "# IDENTITY.md\nName: tictactoe\n",
  "src/index.html": "<h1>tic tac toe</h1>\n",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function metadataDir(): string {
  return path.join(OPENCLAW_DIR, "git-metadata", SLUG, "projects", `${PROJECT}.git`);
}

function seedCheckout(): string {
  const dest = path.join(CUSTOMERS_DIR, SLUG, "projects", PROJECT);
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(path.dirname(metadataDir()), { recursive: true });
  git(dest, ["init", "-q", "-b", "main", "--separate-git-dir", metadataDir()]);
  fs.writeFileSync(`${metadataDir()}.octogee-trusted-v3`, `octogee-customer-git-v3\ngitea:${PROJECT}\n`);
  git(dest, ["config", "user.email", "test@octogee.test"]);
  git(dest, ["config", "user.name", "Octogee Test"]);
  git(dest, ["remote", "add", "origin", `git@gitea.test:${SLUG}/${PROJECT}.git`]);
  for (const [rel, body] of Object.entries(TRACKED)) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), body);
  }
  git(dest, ["add", "-A"]);
  git(dest, ["commit", "-q", "-m", "canonical"]);
  return dest;
}

function emptyTree(dest: string): void {
  for (const entry of fs.readdirSync(dest)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  }
}

const clone = () => cloneProjectRepo(SLUG, PROJECT, PROJECT);

beforeEach(() => {
  fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
  fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
});

describe("cloneProjectRepo on a project directory that already has git metadata", () => {
  it("restores the tracked files when the working tree was emptied", async () => {
    const dest = seedCheckout();
    emptyTree(dest);
    expect(workspaceTreeState(dest)).toEqual({ tracked: 3, missing: 3 });

    await expect(clone()).resolves.toBe(true);

    for (const [rel, body] of Object.entries(TRACKED)) {
      expect(fs.readFileSync(path.join(dest, rel), "utf8")).toBe(body);
    }
    expect(workspaceTreeState(dest)).toEqual({ tracked: 3, missing: 0 });
  });

  it("restores a removed project directory from retained external Git metadata", async () => {
    const dest = seedCheckout();
    const head = git(dest, ["rev-parse", "HEAD"]);
    fs.rmSync(dest, { recursive: true });

    await expect(clone()).resolves.toBe(true);

    for (const [rel, body] of Object.entries(TRACKED)) {
      expect(fs.readFileSync(path.join(dest, rel), "utf8")).toBe(body);
    }
    expect(fs.readFileSync(path.join(dest, ".git"), "utf8")).toBe(`gitdir: ${metadataDir()}\n`);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("leaves a partially edited working tree alone", async () => {
    const dest = seedCheckout();
    fs.rmSync(path.join(dest, "src/index.html"));
    fs.writeFileSync(path.join(dest, "AGENTS.md"), "edited locally\n");

    await expect(clone()).resolves.toBe(true);

    expect(fs.existsSync(path.join(dest, "src/index.html"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "AGENTS.md"), "utf8")).toBe("edited locally\n");
  });
});
