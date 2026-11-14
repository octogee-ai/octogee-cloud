import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectRestoreReady } from "@octogee/core/project-asset-state";
import { acquireWorkspaceMutationLeaseSync, projectMutationLeaseGitDir } from "@octogee/core/workspace-mutation-lease";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";

const paths = vi.hoisted(() => ({
  users: `/tmp/octogee-gh-project-${process.pid}`,
  keys: `/tmp/octogee-gh-project-keys-${process.pid}`,
  scratch: `/tmp/octogee-gh-project-scratch-${process.pid}`,
  openclaw: `${process.platform === "linux" ? "/dev/shm" : "/tmp"}/octogee-gh-project-openclaw-${process.pid}`,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  statfs: vi.fn(async () => ({ bavail: 256 * 1024 * 1024, bsize: 1 })),
}));

vi.mock("../lib/config.js", () => ({
  log: vi.fn((message: string) => {
    if (process.env.DEBUG_GIT_LOG) process.stderr.write(`${message}\n`);
  }),
  dlog: vi.fn(),
  GIT_API_URL: "http://gitea-http.octogee.svc.cluster.local:3000/api/v1",
  GIT_SSH_HOST: "gitea",
  OPENCLAW_DIR: paths.openclaw,
  CUSTOMERS_DIR: paths.users,
  CUSTOMER_KEYS_DIR: paths.keys,
  AGENTS_DIR: "/tmp/octogee-fixture/agents",
}));

const broker = vi.hoisted(() => ({
  clone: null as null | ((slug: string, projectSlug: string) => Promise<boolean>),
  calls: 0,
}));

vi.mock("../lib/github-project-clone-broker.js", () => ({
  cloneGithubProjectViaBroker: vi.fn(async (slug: string, projectSlug: string) => {
    broker.calls += 1;
    if (!broker.clone) throw new Error("broker not configured for this test");
    return broker.clone(slug, projectSlug);
  }),
}));

vi.mock("../lib/gitea-admin-broker-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/gitea-admin-broker-client.js")>(),
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

const {
  cloneProjectRepo,
  externalizeUserGitDir,
  githubCloneCredentialEnv,
  projectCheckoutMatchesSource,
} = await import("../lib/git.js");

const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");

const SLUG = "alice";
const GITHUB_REMOTE = "https://github.com/octogee-ai/demo.git";
const GITHUB_REMOTE_B = "https://github.com/octogee-ai/demo2.git";
const GITEA_SSH_REMOTE = `git@gitea:${SLUG}/demo.git`;
const MATERIALIZED_TOKEN = "ghs_materialized_token_must_not_touch_disk";

const savedEnv: Record<string, string | undefined> = {};
let canonicalOrigin: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function localGitExec(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function localConfig(repo: string, key: string): string {
  return git(repo, ["config", "--local", "--get", key]);
}

function localConfigContents(repo: string): string {
  return fs.readFileSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "config"]), "utf8");
}

const prepareRepository = () => {};

function prepareTrustedGithubRepository(
  repoDir: string,
  _slug: string,
  deps: { repoSource?: { provider: string; owner: string; repo: string } | null },
): void {
  const source = deps.repoSource;
  if (source?.provider !== "github") throw new Error("expected GitHub source");
  const projectSlug = path.basename(repoDir);
  const metadata = path.join(
    paths.openclaw,
    "git-metadata",
    SLUG,
    "projects",
    `${projectSlug}.git`,
  );
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.cpSync(path.join(repoDir, ".git"), metadata, { recursive: true });
  fs.rmSync(path.join(repoDir, ".git"), { recursive: true });
  fs.writeFileSync(`${metadata}.octogee-trusted-v3`, [
    "octogee-customer-git-v3",
    `github:${source.owner}/${source.repo}`,
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(repoDir, ".git"), `gitdir: ${metadata}\n`);
}

function seedBareOrigin(): string {
  const origin = path.join(paths.scratch, "origin.git");
  const seed = path.join(paths.scratch, "seed");
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  git(origin, ["init", "-q", "--bare", "-b", "main"]);
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.email", "seed@octogee.test"]);
  git(seed, ["config", "user.name", "Seed"]);
  fs.writeFileSync(path.join(seed, "README.md"), "from github\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);
  return origin;
}

function rebuildTransferredGithubMetadata(
  repoDir: string,
  _slug: string,
  deps: { repoSource?: { provider: "github"; owner: string; repo: string } | null },
): void {
  externalizeUserGitDir(repoDir, {
    repoSource: deps.repoSource,
    fetchCanonical: (worktree, gitDir) => {
      execFileSync("git", [
        "--git-dir",
        gitDir,
        "--work-tree",
        worktree,
        "fetch",
        canonicalOrigin,
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
    },
  });
}

function initRepoWithOrigin(repo: string, remoteUrl: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@octogee.test"]);
  git(repo, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "checked in\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remoteUrl]);
}

beforeEach(() => {
  for (const dir of [paths.users, paths.keys, paths.scratch, paths.openclaw]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  if (process.platform === "linux") {
    expect(fs.statSync(paths.users).dev).not.toBe(fs.statSync(paths.openclaw).dev);
  }
  const origin = seedBareOrigin();
  canonicalOrigin = origin;
  const globalConfig = path.join(paths.scratch, "gitconfig");
  fs.writeFileSync(
    globalConfig,
    [
      "[http]",
      "\tproxy = http://127.0.0.1:1",
      `[url "${origin}"]`,
      `\tinsteadOf = ${GITHUB_REMOTE}`,
      `\tinsteadOf = ${GITHUB_REMOTE_B}`,
      `\tinsteadOf = ${GITEA_SSH_REMOTE}`,
      "",
    ].join("\n"),
  );
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "GATEWAY_CLASS"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_SSH_COMMAND = "false";
  process.env.GATEWAY_CLASS = "isolated";
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [paths.users, paths.keys, paths.scratch, paths.openclaw]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("cloneProjectRepo for a GitHub-backed project", () => {
  it("rebuilds a transferred checkout's missing metadata without replacing local files", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    const metadata = path.join(paths.openclaw, "git-metadata", SLUG, "projects", "demo.git");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, ".git"), `gitdir: ${metadata}\n`);
    fs.writeFileSync(path.join(dest, "README.md"), "from github\n");
    fs.writeFileSync(path.join(dest, "local-only.md"), "preserve me\n");

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: () => { throw new Error("replacement clone must not run"); },
      prepareRepository: rebuildTransferredGithubMetadata,
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, "local-only.md"), "utf8")).toBe("preserve me\n");
    expect(git(dest, ["status", "--porcelain"])).toBe("?? local-only.md");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(fs.existsSync(metadata)).toBe(true);
    expect(fs.existsSync(path.join(paths.openclaw, "git-worktree-quarantine", SLUG))).toBe(false);
  });

  it("fails closed when rebuilt transferred metadata does not verify", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    const metadata = path.join(paths.openclaw, "git-metadata", SLUG, "projects", "demo.git");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, ".git"), `gitdir: ${metadata}\n`);
    fs.writeFileSync(path.join(dest, "local-only.md"), "preserve me\n");
    const prepareRepository = vi.fn();

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: () => { throw new Error("replacement clone must not run"); },
      prepareRepository,
    });

    expect(ok).toBe(false);
    expect(prepareRepository).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(dest, "local-only.md"), "utf8")).toBe("preserve me\n");
    expect(fs.readFileSync(path.join(dest, ".git"), "utf8")).toBe(`gitdir: ${metadata}\n`);
  });

  it("checks the GitHub repo out at the shared project path with the workspace commit identity", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("from github\n");
    expect(localConfig(dest, "user.email")).toBe(`${SLUG}@octogee.com`);
    expect(localConfig(dest, "user.name")).toBe(`Octo (${SLUG})`);
  });

  it("keeps the materialized token out of the checkout's on-disk git config and remote URL", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");

    await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(localConfigContents(dest)).not.toContain(
      MATERIALIZED_TOKEN,
    );
  });

  it("installs an exact GitHub checkout and quarantines a pre-existing local directory", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "local-only.md"), "local work\n");

    const ok = await cloneProjectRepo(SLUG, "demo", "", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dest, "local-only.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("from github\n");
    const quarantineRoot = path.join(paths.openclaw, "git-worktree-quarantine", SLUG);
    const quarantined = fs.readdirSync(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(quarantineRoot, quarantined[0]!, "local-only.md"), "utf8"),
    ).toBe("local work\n");
  });

  it("refreshes a cached Gitea checkout on runtime restore while preserving local work", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(paths.scratch, ["clone", canonicalOrigin, dest]);
    git(dest, ["remote", "set-url", "origin", GITEA_SSH_REMOTE]);
    externalizeUserGitDir(dest, {
      giteaRepoName: "demo",
      fetchCanonical: (_worktree, metadata) => {
        git(metadata, ["fetch", canonicalOrigin, "+refs/heads/*:refs/remotes/origin/*"]);
      },
    });
    fs.writeFileSync(path.join(dest, "README.md"), "uncommitted local edit\n");
    fs.writeFileSync(path.join(dest, "local-only.md"), "untracked local work\n");
    const seed = path.join(paths.scratch, "seed");
    fs.writeFileSync(path.join(seed, "lifecycle-proof.txt"), "committed on Native\n");
    git(seed, ["add", "lifecycle-proof.txt"]);
    git(seed, ["commit", "-m", "native project work"]);
    git(seed, ["push", "origin", "main"]);

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      refreshRemote: true,
      gitExec: localGitExec,
    })).toBe(true);
    expect(fs.readFileSync(path.join(dest, "lifecycle-proof.txt"), "utf8")).toBe("committed on Native\n");
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("uncommitted local edit\n");
    expect(fs.readFileSync(path.join(dest, "local-only.md"), "utf8")).toBe("untracked local work\n");
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
  });

  it("refuses a cached project refresh that would overwrite conflicting local work", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(paths.scratch, ["clone", canonicalOrigin, dest]);
    git(dest, ["remote", "set-url", "origin", GITEA_SSH_REMOTE]);
    externalizeUserGitDir(dest, {
      giteaRepoName: "demo",
      fetchCanonical: (_worktree, metadata) => {
        git(metadata, ["fetch", canonicalOrigin, "+refs/heads/*:refs/remotes/origin/*"]);
      },
    });
    const originalHead = git(dest, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(dest, "README.md"), "keep this local edit\n");
    const seed = path.join(paths.scratch, "seed");
    fs.writeFileSync(path.join(seed, "README.md"), "new upstream edit\n");
    git(seed, ["add", "README.md"]);
    git(seed, ["commit", "-m", "upstream project edit"]);
    git(seed, ["push", "origin", "main"]);

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      refreshRemote: true,
      gitExec: localGitExec,
    })).toBe(false);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("keep this local edit\n");
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(originalHead);
  });

  it("switches one trusted GitHub source to another and quarantines old-only files", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITHUB_REMOTE);
    prepareTrustedGithubRepository(dest, SLUG, {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
    });
    fs.writeFileSync(path.join(dest, "source-a-only.md"), "old source\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo2" },
      gitExec: localGitExec,
      prepareRepository: prepareTrustedGithubRepository,
    })).toBe(true);

    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE_B);
    expect(fs.existsSync(path.join(dest, "source-a-only.md"))).toBe(false);
    const quarantineRoot = path.join(paths.openclaw, "git-worktree-quarantine", SLUG);
    expect(
      fs.readdirSync(quarantineRoot).some((entry) =>
        fs.existsSync(path.join(quarantineRoot, entry, "source-a-only.md"))),
    ).toBe(true);
  });

  it("switches a legacy local-git checkout instead of assuming external metadata exists", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "legacy-only.md"), "legacy\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository: prepareTrustedGithubRepository,
    })).toBe(true);

    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(fs.existsSync(path.join(dest, "legacy-only.md"))).toBe(false);
  });

  it("leaves the prior checkout intact when the source-swap lease is unavailable", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "keep.md"), "keep\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      acquireMutationLease: () => null,
    })).toBe(false);

    expect(fs.readFileSync(path.join(dest, "keep.md"), "utf8")).toBe("keep\n");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("keeps an interrupted source clone outside the live project inventory", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    let temporary = "";
    const interruptedClone = (cwd: string, args: string[]): string | null => {
      expect(args[0]).toBe("clone");
      temporary = args[2];
      expect(path.dirname(temporary)).toBe(path.join(path.dirname(dest), ".octogee-state"));
      expect(fs.readdirSync(path.dirname(dest)).sort()).toEqual([".octogee-state", "demo"]);
      return null;
    };

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: interruptedClone,
    })).toBe(false);

    expect(fs.existsSync(temporary)).toBe(false);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("rejects a redirected project state directory before cloning", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.symlinkSync(paths.scratch, path.join(path.dirname(dest), ".octogee-state"));
    const before = fs.readdirSync(paths.scratch);
    const runGit = vi.fn(() => null);

    await expect(cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: runGit,
    })).rejects.toThrow("project state is not a directory");

    expect(runGit).not.toHaveBeenCalled();
    expect(fs.readdirSync(paths.scratch)).toEqual(before);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("restores the prior checkout when replacement preparation fails", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "keep.md"), "keep\n");
    const failPreparation = vi.fn(() => { throw new Error("prepare failed"); });

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
      gitExec: localGitExec,
      prepareRepository: failPreparation,
    })).toBe(false);

    expect(failPreparation).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(dest, "keep.md"), "utf8")).toBe("keep\n");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
  });

  it("restores prior trusted metadata when replacement preparation fails after writing new metadata", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITHUB_REMOTE);
    prepareTrustedGithubRepository(dest, SLUG, {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
    });
    fs.writeFileSync(path.join(dest, "keep.md"), "keep\n");

    expect(await cloneProjectRepo(SLUG, "demo", "demo", {
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo2" },
      gitExec: localGitExec,
      prepareRepository: (repoDir, slug, deps) => {
        prepareTrustedGithubRepository(repoDir, slug, deps);
        throw new Error("prepare failed after metadata write");
      },
    })).toBe(false);

    expect(fs.readFileSync(path.join(dest, "keep.md"), "utf8")).toBe("keep\n");
    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
  });

  it("hands the materialized token to git as the password, overriding any ambient helper", () => {
    const env = githubCloneCredentialEnv(MATERIALIZED_TOKEN);

    const filled = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(filled).toContain("username=x-access-token");
    expect(filled).toContain(`password=${MATERIALIZED_TOKEN}`);
  });

  it("asks git for no credential override when no token was materialized", () => {
    expect(githubCloneCredentialEnv(null)).toBeUndefined();
    expect(githubCloneCredentialEnv("")).toBeUndefined();
  });

  it("still clones from Gitea when the project carries no GitHub repoSource", async () => {
    const keyDir = path.join(paths.keys, SLUG);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, "id_ed25519"), "not-a-real-key\n");
    const dest = path.join(paths.users, SLUG, "projects", "demo");

    const ok = await cloneProjectRepo(SLUG, "demo", "demo", {
      gitExec: localGitExec,
      prepareRepository,
    });

    expect(ok).toBe(true);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITEA_SSH_REMOTE);
    expect(localConfig(dest, "user.email")).toBe(`${SLUG}@octogee.com`);
  });
});

describe("GitHub checkouts brokered through gateway-edge", () => {
  const repoSource = { provider: "github" as const, owner: "octogee-ai", repo: "demo" };

  function edgeBrokerClone(): (slug: string, projectSlug: string) => Promise<boolean> {
    return async (slug, projectSlug) => {
      const dest = path.join(paths.users, slug, "projects", projectSlug);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      git(path.dirname(dest), ["clone", "-q", canonicalOrigin, dest]);
      git(dest, ["remote", "set-url", "origin", GITHUB_REMOTE]);
      return true;
    };
  }

  beforeEach(() => {
    broker.calls = 0;
    broker.clone = edgeBrokerClone();
    process.env.GATEWAY_EDGE_INTERNAL_URL = "http://127.0.0.1:3001";
  });

  afterEach(() => {
    delete process.env.GATEWAY_EDGE_INTERNAL_URL;
    broker.clone = null;
  });

  it("prepares a brokered clone canonically so the next probe recognises the checkout", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");

    const ok = await cloneProjectRepo(SLUG, "demo", "", { repoSource });

    expect(ok).toBe(true);
    expect(broker.calls).toBe(1);
    expect(fs.lstatSync(path.join(dest, ".git")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("from github\n");
    expect(projectCheckoutMatchesSource(SLUG, "demo", "", repoSource)).toBe(true);
    expect(localConfig(dest, "remote.origin.url")).toBe(GITHUB_REMOTE);
    expect(fs.readdirSync(path.dirname(dest)).filter((name) => name.startsWith(".demo-brokered-git-"))).toEqual([]);

    await expect(cloneProjectRepo(SLUG, "demo", "", { repoSource })).resolves.toBe(true);
    expect(broker.calls).toBe(1);
  });

  describe.skipIf(process.platform !== "linux")("prepared project asset readiness", () => {
    let previousMount: string | undefined;
    beforeEach(() => {
      previousMount = process.env.OCTOGEE_PROJECTS_MOUNT;
      process.env.OCTOGEE_PROJECTS_MOUNT = paths.users;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    });
    afterEach(() => {
      if (previousMount === undefined) delete process.env.OCTOGEE_PROJECTS_MOUNT;
      else process.env.OCTOGEE_PROJECTS_MOUNT = previousMount;
      vi.unstubAllGlobals();
    });

    function restoringAdapter(isIsolatedGateway = () => true) {
      const manifestRead = vi.fn(async () => ({
        url: "https://signed.test/manifest", method: "GET", gcsPath: "manifest", expiresAt: "later",
      }));
      const blobRead = vi.fn<FleetBrokerClient["blobMaterializationReadUrl"]>();
      const client = { workspaceManifestReadUrl: manifestRead, blobMaterializationReadUrl: blobRead } as unknown as FleetBrokerClient;
      return { manifestRead, blobRead, adapter: buildBrokeredLifecycleAdapter({
        client, rpc: {} as GatewayRpcClient, log: vi.fn(), isIsolatedGateway,
      }) };
    }

    it.each(["github", "gitea"] as const)("refreshes an empty %s repository before its first commit", async provider => {
      git(canonicalOrigin, ["update-ref", "-d", "refs/heads/main"]);
      const keyDir = path.join(paths.keys, SLUG);
      fs.mkdirSync(keyDir, { recursive: true });
      fs.writeFileSync(path.join(keyDir, "id_ed25519"), "not-a-real-key\n");
      const { adapter, manifestRead } = restoringAdapter(() => false);
      const options = { repoSource: provider === "github" ? repoSource : undefined, gitExec: localGitExec,
        prepareRepository: provider === "gitea" ? (worktree: string) => {
          externalizeUserGitDir(worktree, { giteaRepoName: "demo", fetchCanonical: (_dest, metadata) => {
            git(metadata, ["fetch", canonicalOrigin, "+refs/heads/*:refs/remotes/origin/*"]);
          } });
        } : undefined,
      };
      await expect(adapter.cloneProjectRepo(SLUG, "demo", "demo", options)).resolves.toBe(true);
      const dest = path.join(paths.users, SLUG, "projects", "demo");
      const pointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });

      await expect(adapter.cloneProjectRepo(SLUG, "demo", "demo", { ...options, refreshRemote: true })).resolves.toBe(true);

      expect(git(dest, ["rev-parse", "--revs-only", "HEAD"])).toBe("");
      expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).toBe(pointer.birthtimeNs);
      expect(manifestRead).not.toHaveBeenCalled();
    });

    it("hydrates the first upstream commit of an unborn project when preparing a user", async () => {
      git(canonicalOrigin, ["update-ref", "-d", "refs/heads/main"]);
      let user = false;
      const { adapter, blobRead } = restoringAdapter(() => user);
      await adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource });
      const dest = path.join(paths.users, SLUG, "projects", "demo");
      const pointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });
      expect(git(dest, ["rev-parse", "--revs-only", "HEAD"])).toBe("");
      const seed = path.join(paths.scratch, "seed");
      const gcsPath = `customers/${SLUG}/projects/demo/asset.bin`;
      fs.mkdirSync(path.join(seed, ".files"));
      fs.writeFileSync(path.join(seed, ".files", "manifest.json"), JSON.stringify({
        "asset.bin": { type: "blob", gcsPath, size: 3, mimeType: "application/octet-stream", uploadedAt: "2026-10-16T18:00:00Z" },
      }));
      git(seed, ["add", ".files/manifest.json"]);
      git(seed, ["commit", "-q", "-m", "first published asset manifest"]);
      git(seed, ["push", "-q", "origin", "main"]);
      blobRead.mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==",
        download: { url: "https://signed.test/blob", method: "GET", gcsPath, expiresAt: "later" } });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("abc", { headers: { "x-goog-generation": "17" } })));
      user = true;
      const options = { repoSource, refreshRemote: true, gitExec: localGitExec };

      await expect(adapter.cloneProjectRepo(SLUG, "demo", null, options)).resolves.toBe(true);

      expect(git(dest, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
      expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).toBe(pointer.birthtimeNs);
      expect(blobRead).toHaveBeenCalledWith({ slug: SLUG, path: "projects/demo/asset.bin", size: 3 });
      expect(fs.readFileSync(path.join(dest, "asset.bin"), "utf8")).toBe("abc");
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
    });

    it.each(["022", "077"])("refreshes an unchanged prepared checkout without repeating hydration under umask %s", async mask => {
      const umask = Number.parseInt(mask, 8);
      const previousUmask = process.umask(umask);
      try {
        const dest = path.join(paths.users, SLUG, "projects", "demo");
        const { adapter, manifestRead } = restoringAdapter();
        await expect(adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource })).resolves.toBe(true);
        expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
        const pointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });
        expect(pointer.mode & 0o777n).toBe(BigInt(0o444 & ~umask));
        let competingLease: ReturnType<typeof acquireWorkspaceMutationLeaseSync> = null;
        const acquire = vi.fn<typeof acquireWorkspaceMutationLeaseSync>(options => {
          const lease = acquireWorkspaceMutationLeaseSync(options);
          expect(lease).not.toBeNull();
          return { ownerToken: lease!.ownerToken, release() {
            lease!.release();
            competingLease = acquireWorkspaceMutationLeaseSync({
              workspaceDir: dest, gitDir: projectMutationLeaseGitDir(dest, paths.users)!,
            });
            expect(competingLease).not.toBeNull();
          } };
        });
        const options = { repoSource, refreshRemote: true, gitExec: localGitExec, acquireMutationLease: acquire };
        try {
          await expect(adapter.cloneProjectRepo(SLUG, "demo", null, options)).resolves.toBe(true);
          expect(acquire).toHaveBeenCalledOnce();
          expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
          expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).toBe(pointer.birthtimeNs);
          expect(manifestRead).toHaveBeenCalledOnce();
          expect(process.umask()).toBe(umask);
          expect(fs.statSync(path.join(dest, ".git")).mode & 0o777).toBe(0o444 & ~umask);
        } finally { (competingLease as ReturnType<typeof acquireWorkspaceMutationLeaseSync>)?.release(); }
      } finally { process.umask(previousUmask); }
    });

    it.each(["lifecycle", "Canvas"])("hydrates an advanced asset manifest after a %s fast-forward", async writer => {
      const seed = path.join(paths.scratch, "seed");
      fs.mkdirSync(path.join(seed, ".files"));
      fs.writeFileSync(path.join(seed, ".files", "manifest.json"), "{}");
      git(seed, ["add", ".files/manifest.json"]);
      git(seed, ["commit", "-q", "-m", "initial asset manifest"]);
      git(seed, ["push", "-q", "origin", "main"]);
      const dest = path.join(paths.users, SLUG, "projects", "demo");
      const { adapter, blobRead } = restoringAdapter();
      await adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource });
      const pointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
      const gcsPath = `customers/${SLUG}/projects/demo/asset.bin`;
      fs.writeFileSync(path.join(seed, ".files", "manifest.json"), JSON.stringify({
        "asset.bin": { type: "blob", gcsPath, size: 3, mimeType: "application/octet-stream", uploadedAt: "2026-10-16T18:00:00Z" },
      }));
      git(seed, ["add", ".files/manifest.json"]);
      git(seed, ["commit", "-q", "-m", "new asset"]);
      git(seed, ["push", "-q", "origin", "main"]);
      blobRead.mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==",
        download: { url: "https://signed.test/blob", method: "GET", gcsPath, expiresAt: "later" } });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("abc", { headers: { "x-goog-generation": "17" } })));
      if (writer === "Canvas") {
        expect(git(dest, ["status", "--porcelain"])).toBe("");
        const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: dest, gitDir: projectMutationLeaseGitDir(dest, paths.users)! });
        expect(lease).not.toBeNull();
        try {
          git(dest, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
          git(dest, ["merge", "--ff-only", "--no-edit", "origin/main"]);
        } finally { lease!.release(); }
        expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).toBe(pointer.birthtimeNs);
      }
      let readinessAfterRefresh: Promise<boolean> | undefined;
      const options = { repoSource, refreshRemote: true, gitExec: localGitExec,
        acquireMutationLease: (input: Parameters<typeof acquireWorkspaceMutationLeaseSync>[0]) => {
          const lease = acquireWorkspaceMutationLeaseSync(input);
          expect(lease).not.toBeNull();
          return { ownerToken: lease!.ownerToken, release() {
            lease!.release();
            readinessAfterRefresh = readProjectRestoreReady(dest, SLUG, "demo");
          } };
        },
      };

      await expect(adapter.cloneProjectRepo(SLUG, "demo", null, options)).resolves.toBe(true);

      expect(await readinessAfterRefresh).toBe(false);
      expect(git(dest, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
      expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).toBe(pointer.birthtimeNs);
      expect(blobRead).toHaveBeenCalledWith({ slug: SLUG, path: "projects/demo/asset.bin", size: 3 });
      expect(fs.readFileSync(path.join(dest, "asset.bin"), "utf8")).toBe("abc");
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
    });

    it("restores asset readiness after rebuilding an emptied working tree with retained Git metadata", async () => {
      const seed = path.join(paths.scratch, "seed");
      const gcsPath = `customers/${SLUG}/projects/demo/asset.bin`;
      fs.mkdirSync(path.join(seed, ".files"));
      fs.writeFileSync(path.join(seed, ".files", "manifest.json"), JSON.stringify({
        "asset.bin": { type: "blob", gcsPath, size: 3, mimeType: "application/octet-stream", uploadedAt: "2026-10-16T18:00:00Z" },
      }));
      git(seed, ["add", ".files/manifest.json"]);
      git(seed, ["commit", "-q", "-m", "asset manifest"]);
      git(seed, ["push", "-q", "origin", "main"]);
      const dest = path.join(paths.users, SLUG, "projects", "demo");
      const { adapter, blobRead } = restoringAdapter();
      blobRead.mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==",
        download: { url: "https://signed.test/blob", method: "GET", gcsPath, expiresAt: "later" } });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("abc", { headers: { "x-goog-generation": "17" } })));
      await adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource });
      expect(fs.readFileSync(path.join(dest, "asset.bin"), "utf8")).toBe("abc");
      const pointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });
      for (const entry of fs.readdirSync(dest).filter(entry => entry !== ".git")) {
        fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
      }
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(false);
      const options = { repoSource, refreshRemote: true, gitExec: localGitExec };

      await expect(adapter.cloneProjectRepo(SLUG, "demo", null, options)).resolves.toBe(true);

      expect(fs.readFileSync(path.join(dest, "asset.bin"), "utf8")).toBe("abc");
      expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).not.toBe(pointer.birthtimeNs);
      expect(blobRead).toHaveBeenCalledTimes(2);
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
    });

    it("normalizes retained same-origin Git configuration without invalidating asset readiness", async () => {
      const dest = path.join(paths.users, SLUG, "projects", "demo");
      const { adapter, manifestRead } = restoringAdapter();
      await adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource });
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
      const originalPointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });
      git(dest, ["config", "user.name", "Stale retained identity"]);
      git(dest, ["config", "remote.origin.fetch", "+refs/heads/topic:refs/remotes/origin/topic"]);

      await expect(adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource })).resolves.toBe(true);

      expect(localConfig(dest, "user.name")).toBe(`Octo (${SLUG})`);
      expect(localConfig(dest, "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
      expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).toBe(originalPointer.birthtimeNs);
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
      expect(manifestRead).toHaveBeenCalledOnce();
    });

    it("requires new asset readiness when the canonical project source changes", async () => {
      const dest = path.join(paths.users, SLUG, "projects", "demo");
      const { adapter, manifestRead } = restoringAdapter();
      await adapter.cloneProjectRepo(SLUG, "demo", null, { repoSource });
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
      const originalPointer = fs.lstatSync(path.join(dest, ".git"), { bigint: true });
      const clone = edgeBrokerClone();
      broker.clone = async (slug, project) => {
        await clone(slug, project);
        git(path.join(paths.users, slug, "projects", project), ["remote", "set-url", "origin", GITHUB_REMOTE_B]);
        return true;
      };

      await expect(adapter.cloneProjectRepo(SLUG, "demo", null, {
        repoSource: { ...repoSource, repo: "demo2" },
      })).resolves.toBe(true);

      expect(fs.lstatSync(path.join(dest, ".git"), { bigint: true }).birthtimeNs).not.toBe(originalPointer.birthtimeNs);
      expect(manifestRead).toHaveBeenCalledTimes(2);
      expect(await readProjectRestoreReady(dest, SLUG, "demo")).toBe(true);
    });
  });

  it("sets a checkout that does not match its GitHub source aside and re-clones through the broker", async () => {
    const dest = path.join(paths.users, SLUG, "projects", "demo");
    initRepoWithOrigin(dest, GITEA_SSH_REMOTE);
    fs.writeFileSync(path.join(dest, "local-only.md"), "local work\n");
    externalizeUserGitDir(dest, {
      giteaRepoName: `${SLUG}-demo`,
      fetchCanonical: (worktree, gitDir) => {
        execFileSync("git", ["--git-dir", gitDir, "--work-tree", worktree, "fetch", canonicalOrigin, "+refs/heads/*:refs/remotes/origin/*"]);
      },
    });
    expect(projectCheckoutMatchesSource(SLUG, "demo", `${SLUG}-demo`, null)).toBe(true);

    const ok = await cloneProjectRepo(SLUG, "demo", "", { repoSource });

    expect(ok).toBe(true);
    expect(broker.calls).toBe(1);
    expect(projectCheckoutMatchesSource(SLUG, "demo", "", repoSource)).toBe(true);
    expect(fs.existsSync(path.join(dest, "local-only.md"))).toBe(false);
    const quarantineRoot = path.join(paths.openclaw, "git-worktree-quarantine", SLUG);
    const quarantined = fs.readdirSync(quarantineRoot);
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantineRoot, quarantined[0]!, "local-only.md"), "utf8")).toBe("local work\n");
  });

  it("reports a brokered clone whose origin is not the project's repository", async () => {
    broker.clone = async (slug, projectSlug) => {
      const dest = path.join(paths.users, slug, "projects", projectSlug);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      git(path.dirname(dest), ["clone", "-q", canonicalOrigin, dest]);
      git(dest, ["remote", "set-url", "origin", GITHUB_REMOTE_B]);
      return true;
    };

    await expect(cloneProjectRepo(SLUG, "demo", "", { repoSource })).resolves.toBe(false);
  });
});
