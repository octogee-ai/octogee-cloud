import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), "octogee-git-metadata-"));
});

vi.mock("../lib/config.js", () => ({
  log: () => {},
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: TEST_ROOT,
  CUSTOMERS_DIR: path.join(TEST_ROOT, "customers"),
  CUSTOMER_KEYS_DIR: path.join(TEST_ROOT, "keys"),
  AGENTS_DIR: path.join(TEST_ROOT, "agents"),
}));

const { userRepositoryHasCanonicalRemote, externalizeUserGitDir, gitExec } =
  await import("../lib/git.js");

const CUSTOMERS_DIR = path.join(TEST_ROOT, "customers");
const METADATA_ROOT = path.join(TEST_ROOT, "git-metadata");
const TRUST_RECEIPT_SUFFIX = ".octogee-trusted-v3";

interface CanonicalRepo {
  root: string;
  bare: string;
  head: string | null;
}

interface RepoCase {
  name: string;
  slug: string;
  projectSlug?: string;
  repoDir: string;
  metadataDir: string;
  remoteUrl: string;
  legacyObjectMode: "symlink" | "alternates";
}

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

function createCanonicalRepo(files?: Record<string, string>): CanonicalRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-canonical-git-"));
  const bare = path.join(root, "canonical.git");
  if (!files) {
    fs.mkdirSync(bare);
    git(root, ["init", "--bare", "--initial-branch=main", bare]);
    return { root, bare, head: null };
  }
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, ["init", "--initial-branch=main", "."]);
  git(work, ["config", "user.email", "tests@octogee.test"]);
  git(work, ["config", "user.name", "Octogee Tests"]);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(work, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "canonical"]);
  git(root, ["clone", "--bare", work, bare]);
  return { root, bare, head: git(work, ["rev-parse", "HEAD"]) };
}

function fetchCanonicalFrom(remote: string, onFetch?: () => void) {
  return (_repoDir: string, gitDir: string) => {
    onFetch?.();
    git(gitDir, [
      "--git-dir",
      gitDir,
      "fetch",
      remote,
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  };
}

function writeWorktree(repoDir: string, files: Record<string, string>): void {
  fs.mkdirSync(repoDir, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(repoDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function treeSnapshot(root: string, excludeGit = false): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  const walk = (current: string, relative: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      if (excludeGit && childRelative === ".git") continue;
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) {
        snapshot[childRelative] = {
          type: "symlink",
          mode: stat.mode & 0o777,
          target: fs.readlinkSync(child),
        };
      } else if (stat.isDirectory()) {
        snapshot[childRelative] = { type: "directory", mode: stat.mode & 0o777 };
        walk(child, childRelative);
      } else {
        snapshot[childRelative] = {
          type: "file",
          mode: stat.mode & 0o777,
          data: fs.readFileSync(child).toString("base64"),
        };
      }
    }
  };
  walk(root, "");
  return snapshot;
}

function createLegacyMetadata(repoCase: RepoCase): {
  externalRoot: string;
  externalObjects: string;
  hookMarker: string;
} {
  const oldGit = path.join(repoCase.repoDir, ".git");
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-external-commondir-"));
  const externalObjects = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-external-objects-"));
  const hookMarker = path.join(repoCase.repoDir, "legacy-hook-ran");
  fs.mkdirSync(oldGit, { recursive: true });
  fs.writeFileSync(path.join(oldGit, "commondir"), `${externalRoot}\n`);
  fs.writeFileSync(path.join(oldGit, "HEAD"), "ref: refs/heads/attacker\n");
  fs.writeFileSync(path.join(oldGit, "index"), "attacker-controlled-index\n");
  fs.mkdirSync(path.join(oldGit, "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(oldGit, "hooks", "post-checkout"),
    `#!/bin/sh\ntouch "${hookMarker}"\n`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(oldGit, "info"), { recursive: true });
  fs.writeFileSync(
    path.join(oldGit, "info", "grafts"),
    `${"a".repeat(40)} ${"b".repeat(40)}\n`,
  );
  fs.mkdirSync(path.join(oldGit, "refs", "replace"), { recursive: true });
  fs.writeFileSync(path.join(oldGit, "refs", "replace", "a".repeat(40)), `${"b".repeat(40)}\n`);
  if (repoCase.legacyObjectMode === "symlink") {
    fs.symlinkSync(externalObjects, path.join(oldGit, "objects"));
  } else {
    fs.mkdirSync(path.join(oldGit, "objects", "info"), { recursive: true });
    fs.writeFileSync(
      path.join(oldGit, "objects", "info", "alternates"),
      `${externalObjects}\n`,
    );
  }
  fs.writeFileSync(
    path.join(externalRoot, "config"),
    `[core]\n\thooksPath = ${path.join(oldGit, "hooks")}\n[filter "attacker"]\n\tclean = touch ${hookMarker}; cat\n`,
  );
  fs.mkdirSync(path.join(externalRoot, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(externalRoot, "refs", "heads", "main"), `${"c".repeat(40)}\n`);
  return { externalRoot, externalObjects, hookMarker };
}

function statusLines(repoDir: string): string[] {
  const status = execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain",
      "--untracked-files=all",
    ],
    {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trimEnd();
  return status ? status.split("\n").sort() : [];
}

function findNamed(root: string, basename: string): string | null {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.name === basename) return candidate;
    if (entry.isDirectory()) {
      const nested = findNamed(candidate, basename);
      if (nested) return nested;
    }
  }
  return null;
}

function metadataCases(): RepoCase[] {
  return [
    {
      name: "workspace",
      slug: "legacyws",
      repoDir: path.join(CUSTOMERS_DIR, "legacyws"),
      metadataDir: path.join(METADATA_ROOT, "legacyws", "workspace.git"),
      remoteUrl: "git@gitea.test:legacyws/workspace.git",
      legacyObjectMode: "symlink",
    },
    {
      name: "project",
      slug: "legacyproj",
      projectSlug: "garden",
      repoDir: path.join(CUSTOMERS_DIR, "legacyproj", "projects", "garden"),
      metadataDir: path.join(METADATA_ROOT, "legacyproj", "projects", "garden.git"),
      remoteUrl: "git@gitea.test:legacyproj/garden.git",
      legacyObjectMode: "alternates",
    },
  ];
}

describe("user Git metadata refresh", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const name of fs.readdirSync(TEST_ROOT)) {
      fs.rmSync(path.join(TEST_ROOT, name), { recursive: true, force: true });
    }
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

  it.each(metadataCases())(
    "rebuilds $name metadata only from canonical main while preserving visible M/D/?? worktree state",
    (repoCase) => {
      const canonical = createCanonicalRepo({
        "modified.txt": "canonical\n",
        "deleted.txt": "delete me\n",
        "unchanged.txt": "same\n",
      });
      temporaryRoots.push(canonical.root);
      writeWorktree(repoCase.repoDir, {
        "modified.txt": "local change\n",
        "unchanged.txt": "same\n",
        "untracked.txt": "local only\n",
      });
      const legacy = createLegacyMetadata(repoCase);
      temporaryRoots.push(legacy.externalRoot, legacy.externalObjects);
      const before = treeSnapshot(repoCase.repoDir, true);

      expect(externalizeUserGitDir(repoCase.repoDir, {
        fetchCanonical: fetchCanonicalFrom(canonical.bare),
      })).toBe(repoCase.metadataDir);

      expect(treeSnapshot(repoCase.repoDir, true)).toEqual(before);
      expect(statusLines(repoCase.repoDir)).toEqual([
        " D deleted.txt",
        " M modified.txt",
        "?? untracked.txt",
      ].sort());
      expect(gitExec(repoCase.repoDir, ["rev-parse", "HEAD"])).toBe(canonical.head);
      expect(gitExec(repoCase.repoDir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
      expect(gitExec(repoCase.repoDir, ["ls-files"])).toBe(
        ["deleted.txt", "modified.txt", "unchanged.txt"].join("\n"),
      );
      expect(git(repoCase.metadataDir, [
        "config",
        "--file",
        path.join(repoCase.metadataDir, "config"),
        "remote.origin.url",
      ])).toBe(repoCase.remoteUrl);
      expect(() => git(repoCase.metadataDir, [
        "config",
        "--file",
        path.join(repoCase.metadataDir, "config"),
        "filter.attacker.clean",
      ])).toThrow();
      expect(fs.lstatSync(path.join(repoCase.metadataDir, "objects")).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(repoCase.metadataDir, "objects", "info", "alternates"))).toBe(false);
      expect(fs.existsSync(path.join(repoCase.metadataDir, "refs", "replace"))).toBe(false);
      expect(fs.existsSync(path.join(repoCase.metadataDir, "info", "grafts"))).toBe(false);
      expect(fs.existsSync(path.join(repoCase.metadataDir, "hooks", "post-checkout"))).toBe(false);
      expect(fs.readFileSync(path.join(repoCase.metadataDir, "index"), "utf8"))
        .not.toContain("attacker-controlled-index");
      expect(fs.readFileSync(path.join(repoCase.metadataDir, "HEAD"), "utf8"))
        .toBe("ref: refs/heads/main\n");
      expect(fs.existsSync(legacy.hookMarker)).toBe(false);
      expect(fs.readFileSync(path.join(legacy.externalRoot, "refs", "heads", "main"), "utf8"))
        .toBe(`${"c".repeat(40)}\n`);
      const quarantineRoot = path.join(TEST_ROOT, "git-metadata-quarantine", repoCase.slug);
      expect(findNamed(quarantineRoot, "commondir")).not.toBeNull();
    },
  );

  it("projects an empty canonical repository as an unborn main branch with an empty index", () => {
    const canonical = createCanonicalRepo();
    temporaryRoots.push(canonical.root);
    const repoDir = path.join(CUSTOMERS_DIR, "emptyrepo");
    writeWorktree(repoDir, { "local.txt": "untracked\n" });
    const before = treeSnapshot(repoDir, true);

    const metadataDir = externalizeUserGitDir(repoDir, {
      fetchCanonical: fetchCanonicalFrom(canonical.bare),
    });

    expect(metadataDir).toBe(path.join(METADATA_ROOT, "emptyrepo", "workspace.git"));
    expect(treeSnapshot(repoDir, true)).toEqual(before);
    expect(statusLines(repoDir)).toEqual(["?? local.txt"]);
    expect(gitExec(repoDir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(gitExec(repoDir, ["rev-parse", "--verify", "HEAD"])).toBeNull();
    expect(gitExec(repoDir, ["ls-files"])).toBe("");
  });

  it("keeps a failed refresh byte-preserving, quarantines legacy metadata, and converges on retry", () => {
    const canonical = createCanonicalRepo({ "tracked.txt": "canonical\n" });
    temporaryRoots.push(canonical.root);
    const repoDir = path.join(CUSTOMERS_DIR, "retryrepo");
    const repoCase: RepoCase = {
      name: "workspace",
      slug: "retryrepo",
      repoDir,
      metadataDir: path.join(METADATA_ROOT, "retryrepo", "workspace.git"),
      remoteUrl: "git@gitea.test:retryrepo/workspace.git",
      legacyObjectMode: "symlink",
    };
    writeWorktree(repoDir, {
      "tracked.txt": "local change\n",
      "untracked.txt": "local only\n",
    });
    const legacy = createLegacyMetadata(repoCase);
    temporaryRoots.push(legacy.externalRoot, legacy.externalObjects);
    const before = treeSnapshot(repoDir, true);

    expect(() => externalizeUserGitDir(repoDir, {
      fetchCanonical: () => {
        throw new Error("injected canonical fetch failure");
      },
    })).toThrow("injected canonical fetch failure");

    expect(treeSnapshot(repoDir, true)).toEqual(before);
    expect(fs.existsSync(path.join(repoDir, ".git"))).toBe(false);
    expect(fs.existsSync(repoCase.metadataDir)).toBe(false);
    expect(fs.existsSync(`${repoCase.metadataDir}${TRUST_RECEIPT_SUFFIX}`)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(repoCase.metadataDir)).filter((name) =>
        name.startsWith(`${path.basename(repoCase.metadataDir)}.octogee-new-`)),
    ).toEqual([]);
    const quarantineRoot = path.join(TEST_ROOT, "git-metadata-quarantine", repoCase.slug);
    const quarantinedHook = findNamed(quarantineRoot, "post-checkout");
    expect(quarantinedHook).not.toBeNull();

    expect(externalizeUserGitDir(repoDir, {
      fetchCanonical: fetchCanonicalFrom(canonical.bare),
    })).toBe(repoCase.metadataDir);
    expect(treeSnapshot(repoDir, true)).toEqual(before);
    expect(statusLines(repoDir)).toEqual([" M tracked.txt", "?? untracked.txt"]);
    expect(gitExec(repoDir, ["rev-parse", "HEAD"])).toBe(canonical.head);
    expect(fs.existsSync(`${repoCase.metadataDir}${TRUST_RECEIPT_SUFFIX}`)).toBe(true);
    expect(fs.statSync(quarantinedHook!).mode & 0o111).toBe(0);
  });

  it("uses the exact trust receipt as the no-op postcondition and rebuilds after receipt corruption", () => {
    const canonical = createCanonicalRepo({ "README.md": "canonical\n" });
    temporaryRoots.push(canonical.root);
    const repoDir = path.join(CUSTOMERS_DIR, "receiptcheck");
    const metadataDir = path.join(METADATA_ROOT, "receiptcheck", "workspace.git");
    const receipt = `${metadataDir}${TRUST_RECEIPT_SUFFIX}`;
    writeWorktree(repoDir, { "README.md": "canonical\n" });
    let fetches = 0;

    expect(externalizeUserGitDir(repoDir, {
      fetchCanonical: fetchCanonicalFrom(canonical.bare, () => fetches++),
    })).toBe(metadataDir);
    expect(userRepositoryHasCanonicalRemote(repoDir)).toBe(true);
    expect(fetches).toBe(1);
    expect(fs.readFileSync(receipt, "utf8")).toBe(
      "octogee-customer-git-v3\ngitea:workspace\n",
    );
    expect(fs.statSync(receipt).mode & 0o777).toBe(0o400);
    expect(fs.readFileSync(path.join(repoDir, ".git"), "utf8"))
      .toBe(`gitdir: ${metadataDir}\n`);
    expect(fs.statSync(path.join(repoDir, ".git")).mode & 0o777).toBe(0o444);
    const metadataBefore = treeSnapshot(metadataDir);

    expect(externalizeUserGitDir(repoDir, {
      fetchCanonical: () => {
        throw new Error("no-op path fetched unexpectedly");
      },
    })).toBe(metadataDir);
    expect(treeSnapshot(metadataDir)).toEqual(metadataBefore);

    const corrupt = path.join(repoDir, "corrupt-receipt");
    fs.writeFileSync(corrupt, "attacker receipt\n", { flag: "wx" });
    fs.renameSync(corrupt, receipt);
    expect(userRepositoryHasCanonicalRemote(repoDir)).toBe(false);
    fs.writeFileSync(corrupt, Buffer.alloc(1025), { flag: "wx" });
    fs.renameSync(corrupt, receipt);
    expect(userRepositoryHasCanonicalRemote(repoDir)).toBe(false);
    expect(externalizeUserGitDir(repoDir, {
      fetchCanonical: fetchCanonicalFrom(canonical.bare, () => fetches++),
    })).toBe(metadataDir);
    expect(fetches).toBe(2);
    expect(fs.readFileSync(receipt, "utf8")).toBe(
      "octogee-customer-git-v3\ngitea:workspace\n",
    );
    expect(userRepositoryHasCanonicalRemote(repoDir)).toBe(true);
    expect(gitExec(repoDir, ["rev-parse", "HEAD"])).toBe(canonical.head);
  });

  it("recreates a missing user directory when canonical metadata is already trusted", () => {
    const canonical = createCanonicalRepo({ "README.md": "canonical\n" });
    temporaryRoots.push(canonical.root);
    const repoDir = path.join(CUSTOMERS_DIR, "missing-worktree");
    const metadataDir = path.join(METADATA_ROOT, "missing-worktree", "workspace.git");
    writeWorktree(repoDir, { "README.md": "canonical\n" });

    expect(externalizeUserGitDir(repoDir, {
      fetchCanonical: fetchCanonicalFrom(canonical.bare),
    })).toBe(metadataDir);
    fs.rmSync(repoDir, { recursive: true });

    expect(externalizeUserGitDir(repoDir, {
      fetchCanonical: () => {
        throw new Error("trusted metadata fetched unexpectedly");
      },
    })).toBe(metadataDir);
    expect(fs.readFileSync(path.join(repoDir, ".git"), "utf8"))
      .toBe(`gitdir: ${metadataDir}\n`);
    expect(fs.statSync(repoDir).mode & 0o777).toBe(0o700);
  });

  it("treats a transferred workspace with a dangling external metadata pointer as unready", () => {
    const repoDir = path.join(CUSTOMERS_DIR, "transferred");
    const metadataDir = path.join(METADATA_ROOT, "transferred", "workspace.git");
    writeWorktree(repoDir, {
      ".git": `gitdir: ${metadataDir}\n`,
      "local-only.txt": "preserve me\n",
    });

    expect(userRepositoryHasCanonicalRemote(repoDir)).toBe(false);
    expect(fs.readFileSync(path.join(repoDir, "local-only.txt"), "utf8")).toBe("preserve me\n");
  });
});
