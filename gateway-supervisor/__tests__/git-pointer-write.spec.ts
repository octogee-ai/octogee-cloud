import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: `/tmp/octogee-git-pointer-${process.pid}` }));

vi.mock("../lib/config.js", () => ({
  log: vi.fn(),
  dlog: vi.fn(),
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: paths.root,
  CUSTOMERS_DIR: `${paths.root}/customers`,
  CUSTOMER_KEYS_DIR: `${paths.root}/keys`,
  AGENTS_DIR: `${paths.root}/agents`,
}));

const { externalizeUserGitDir, generateUserSshKey, setRepoSshCommand } = await import("../lib/git.js");
const repo = path.join(paths.root, "customers", "alice");
const pointer = path.join(repo, ".git");
const legacyTemporary = path.join(repo, ".git.octogee.tmp");

function git(args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd: repo,
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

function refresh(): string | null {
  return externalizeUserGitDir(repo, {
    fetchCanonical: () => { throw new Error("Trusted metadata must not be fetched"); },
  });
}

beforeEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
  externalizeUserGitDir(repo, { fetchCanonical: () => {} });
});

afterEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
});

it("rejects a noncanonical key owner before creating a key directory", () => {
  expect(() => generateUserSshKey("../outside")).toThrow("Invalid SSH key owner");
  expect(fs.existsSync(path.join(paths.root, "outside"))).toBe(false);
});

it("creates and reuses a keypair for a canonical owner", () => {
  const publicKey = generateUserSshKey("alice");
  expect(publicKey).toMatch(/^ssh-ed25519 .* octogee-alice@gateway$/u);
  expect(generateUserSshKey("alice")).toBe(publicKey);
});

it("restores private modes on a reused keypair that a volume group walk loosened", () => {
  const publicKey = generateUserSshKey("alice");
  const keyDir = path.join(paths.root, "keys", "alice");
  const keyPath = path.join(keyDir, "id_ed25519");
  fs.chmodSync(keyDir, 0o2770);
  fs.chmodSync(keyPath, 0o660);
  fs.chmodSync(`${keyPath}.pub`, 0o664);

  expect(generateUserSshKey("alice")).toBe(publicKey);
  expect(fs.statSync(keyDir).mode & 0o7777).toBe(0o700);
  expect(fs.statSync(keyPath).mode & 0o7777).toBe(0o600);
  expect(fs.statSync(`${keyPath}.pub`).mode & 0o7777).toBe(0o644);
});

describe("user Git pointer replacement", () => {
  it.each(["existing", "dangling"])("refreshes a Gitea workspace with a tracked temporary-name symlink to a sibling's %s file", (kind) => {
    const outside = path.join(paths.root, "customers", "bob", "notes.txt");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    if (kind === "existing") fs.writeFileSync(outside, "outside contents\n");
    fs.symlinkSync(outside, legacyTemporary);
    git(["add", ".git.octogee.tmp"]);
    git(["commit", "-m", "Track a legitimate symlink"]);
    const head = git(["rev-parse", "HEAD"]);

    setRepoSshCommand(repo, "alice", {
      fetchCanonical: () => { throw new Error("Trusted metadata must not be fetched"); },
    });
    const metadata = path.join(paths.root, "git-metadata", "alice", "workspace.git");

    if (kind === "existing") expect(fs.readFileSync(outside, "utf8")).toBe("outside contents\n");
    else expect(fs.existsSync(outside)).toBe(false);
    expect(fs.lstatSync(legacyTemporary).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacyTemporary)).toBe(outside);
    expect(git(["rev-parse", "HEAD"])).toBe(head);
    expect(git(["ls-files", "--stage", ".git.octogee.tmp"])).toMatch(/^120000 /);
    expect(git(["status", "--porcelain"])).toBe("");
    expect(fs.lstatSync(pointer).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(pointer, "utf8")).toBe(`gitdir: ${metadata}\n`);
    expect(git(["remote", "get-url", "origin"])).toBe("git@gitea.test:alice/workspace.git");
  });

  it("preserves a regular file at the former temporary pathname", () => {
    fs.writeFileSync(legacyTemporary, "user file\n");

    refresh();

    expect(fs.readFileSync(legacyTemporary, "utf8")).toBe("user file\n");
    expect(git(["status", "--porcelain"])).toBe("?? .git.octogee.tmp");
  });

  it("preserves an unpushed commit, index, and staged, unstaged, untracked, and symlink content", () => {
    fs.writeFileSync(path.join(repo, "staged.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "unstaged.txt"), "base\n");
    fs.symlinkSync("staged.txt", path.join(repo, "link.txt"));
    git(["add", "-A"]);
    git(["commit", "-m", "Unpushed work"]);
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    git(["add", "staged.txt"]);
    fs.writeFileSync(path.join(repo, "unstaged.txt"), "unstaged\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    const metadata = git(["rev-parse", "--absolute-git-dir"]);
    const head = git(["rev-parse", "HEAD"]);
    const status = git(["status", "--porcelain"]);
    const index = fs.readFileSync(path.join(metadata, "index"));

    expect(fs.realpathSync(refresh()!)).toBe(metadata);

    expect(fs.readFileSync(path.join(metadata, "index"))).toEqual(index);
    expect(git(["rev-parse", "HEAD"])).toBe(head);
    expect(git(["status", "--porcelain"])).toBe(status);
    expect(fs.readlinkSync(path.join(repo, "link.txt"))).toBe("staged.txt");
    expect(fs.readFileSync(path.join(repo, "staged.txt"), "utf8")).toBe("staged\n");
    expect(fs.readFileSync(path.join(repo, "unstaged.txt"), "utf8")).toBe("unstaged\n");
    expect(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(fs.statSync(pointer).mode & 0o777).toBe(0o444);
    expect(fs.readdirSync(repo).filter(name => name.startsWith(".git.octogee"))).toEqual([]);
  });

  it("removes its temporary pointer when replacing the destination fails", () => {
    fs.rmSync(pointer);
    fs.mkdirSync(pointer);
    fs.writeFileSync(path.join(pointer, "keep.txt"), "keep\n");

    expect(refresh).toThrow();

    expect(fs.readFileSync(path.join(pointer, "keep.txt"), "utf8")).toBe("keep\n");
    expect(fs.readdirSync(repo).filter(name => name.startsWith(".git.octogee"))).toEqual([]);
  });

  it("refreshes without writing through a symlink at the former randomized pathname", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const collision = `${pointer}.octogee-${id}.tmp`;
    const outside = path.join(paths.root, "outside.txt");
    fs.writeFileSync(outside, "outside contents\n");
    fs.symlinkSync(outside, collision);
    fs.chmodSync(pointer, 0o644);
    const previousPointer = fs.readFileSync(pointer, "utf8");
    expect(refresh()).toBe(path.join(paths.root, "git-metadata", "alice", "workspace.git"));

    expect(fs.readFileSync(outside, "utf8")).toBe("outside contents\n");
    expect(fs.readlinkSync(collision)).toBe(outside);
    expect(fs.readFileSync(pointer, "utf8")).toBe(previousPointer);
  });
});
