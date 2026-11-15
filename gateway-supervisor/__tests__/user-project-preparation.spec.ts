import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import type { UserLifecycleAdapter, ProjectCloneOptions } from "../lib/user-lifecycle.js";

const paths = vi.hoisted(() => ({ root: `/tmp/octogee-user-project-preparation-${process.pid}-${Date.now()}` }));
vi.mock("../lib/config.js", () => ({
  log: vi.fn(), dlog: vi.fn(), OPENCLAW_DIR: paths.root,
  CUSTOMERS_DIR: `${paths.root}/customers`, CUSTOMER_KEYS_DIR: `${paths.root}/keys`,
  AGENTS_DIR: `${paths.root}/agents`, GIT_API_URL: "http://gitea.test", GIT_SSH_HOST: "gitea",
}));
vi.mock("../lib/gitea-admin-broker-client.js", () => ({ brokeredGitHost: { repoExists: vi.fn(async () => true) } }));
vi.mock("../lib/migration-activation-manifest.js", () => ({ readActivationManifest: vi.fn(async () => ({ slug: "alice" })) }));
const { cloneProjectRepo, userRepositoryHasCanonicalRemote, externalizeUserGitDir, projectCheckoutMatchesSource } = await import("../lib/git.js");
const { createIsolatedSurgeGateWiring } = await import("../lib/fleet-provisioner.js");
const slug = "alice", project = "demo", dir = `${paths.root}/customers/${slug}/projects/${project}`;
const metadata = `${paths.root}/git-metadata/${slug}/projects/${project}.git`;
let origin: string, seed: string;
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}
beforeEach(() => {
  vi.stubEnv("GATEWAY_EDGE_INTERNAL_URL", "");
  fs.rmSync(paths.root, { recursive: true, force: true });
  seed = path.join(paths.root, "seed"); origin = path.join(paths.root, "origin.git");
  fs.mkdirSync(seed, { recursive: true }); fs.mkdirSync(origin);
  git(origin, ["init", "--bare", "-b", "main"]); git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]); git(seed, ["config", "user.email", "test@octogee.test"]);
  fs.writeFileSync(path.join(seed, "README.md"), "seed\n");
  fs.writeFileSync(path.join(seed, "IDENTITY.md"), "old identity\n"); git(seed, ["add", "."]); git(seed, ["commit", "-m", "seed"]);
  git(seed, ["remote", "add", "origin", origin]); git(seed, ["push", "origin", "main"]);
  fs.mkdirSync(path.dirname(metadata), { recursive: true }); fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(paths.root, ["clone", "--separate-git-dir", metadata, origin, dir]);
  git(dir, ["config", "user.name", "Test"]); git(dir, ["config", "user.email", "test@octogee.test"]);
  git(dir, ["remote", "set-url", "origin", `git@gitea:${slug}/${project}.git`]);
  fs.writeFileSync(`${metadata}.octogee-trusted-v3`, `octogee-customer-git-v3\ngitea:${project}\n`);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${metadata}\n`);
  fs.mkdirSync(`${paths.root}/keys/${slug}`, { recursive: true });
  fs.writeFileSync(`${paths.root}/keys/${slug}/id_ed25519`, "isolated test key; no SSH execution");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(paths.root, { recursive: true, force: true }); });

function wiring(provider: "gitea" | "github" = "gitea", failGitCommand?: string) {
  const repoSource = provider === "github" ? { provider: "github" as const, owner: "firebase-test", repo: project } : undefined;
  if (repoSource && fs.existsSync(metadata)) {
    git(dir, ["remote", "set-url", "origin", `https://github.com/${repoSource.owner}/${repoSource.repo}.git`]);
    fs.writeFileSync(`${metadata}.octogee-trusted-v3`, `octogee-customer-git-v3\ngithub:${repoSource.owner}/${repoSource.repo}\n`);
  }
  const target = { projectSlug: project, giteaRepoName: repoSource ? null : project, provisioningState: "active", ...(repoSource ? { repoSource } : {}) };
  const gitCalls: string[][] = [];
  const snapshot = { uid: "uid-alice", slug, gatewayId: "alice-user", status: "complete",
    projectCheckoutScope: "workspace-and-projects", projects: [target] };
  const clone = vi.fn(async (_slug: string, _project: string, repo: string, opts?: ProjectCloneOptions) => cloneProjectRepo(slug, project, repo, {
    ...opts, gitExec: (cwd, args) => {
      gitCalls.push(args);
      if (args[0] === failGitCommand) return null;
      const localArgs = args[0] === "fetch" ? ["fetch", "--no-tags", origin, "+refs/heads/*:refs/remotes/origin/*"]
        : args[0] === "clone" ? ["clone", origin, ...args.slice(2)] : args;
      try { return git(cwd, localArgs); } catch { return null; }
    },
    prepareRepository: worktree => {
      externalizeUserGitDir(worktree, { giteaRepoName: repo, repoSource,
        fetchCanonical: (_dest, gitDir) => { git(gitDir, ["fetch", origin, "+refs/heads/*:refs/remotes/origin/*"]); },
      });
    },
  }));
  const adapter = {
    log: vi.fn(), uidForSlug: async () => snapshot.uid, loadUserSnapshot: vi.fn(async () => snapshot),
    isIsolatedGateway: () => true, isConfiguredUser: () => true,
    listProjectsNeedingClone: vi.fn(async () => userRepositoryHasCanonicalRemote(dir) && projectCheckoutMatchesSource(slug, project, target.giteaRepoName ?? "", repoSource) ? [] : snapshot.projects),
    cloneProjectRepo: clone,
  } as unknown as UserLifecycleAdapter;
  const request = { migrationId: "activation-test", slug, targetPodUid: "target-pod" };
  const processGate = { status: vi.fn(async () => ({ version: 1, podUid: request.targetPodUid, role: "target", mode: "held", phase: "held", ...request })) };
  const attach = vi.fn(async () => slug);
  return { adapter, request, gitCalls, clone, attach, processGate, gate: createIsolatedSurgeGateWiring({ adapter, processGate: processGate as never,
    waitForGatewayHealthy: async () => undefined,
    surgeReadiness: {} as never, waitForGatewayReady: async () => undefined, log: vi.fn(), openclawDir: paths.root,
    provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
    attachConfiguredUserBeforeOpenClaw: attach,
  }) };
}

function retainedState() {
  return {
    head: fs.readFileSync(path.join(metadata, "HEAD")),
    commit: git(dir, ["rev-parse", "HEAD"]),
    index: fs.readFileSync(path.join(metadata, "index")),
    config: fs.readFileSync(path.join(metadata, "config")),
    source: fs.readFileSync(`${metadata}.octogee-trusted-v3`),
    refs: git(dir, ["show-ref"]),
    status: git(dir, ["status", "--porcelain=v1", "-z"]),
    files: Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name))])),
  };
}

function advanceRemote() {
  fs.writeFileSync(path.join(seed, "remote-only.md"), "independent remote commit\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "remote work"]); git(seed, ["push", "origin", "main"]);
}

function commitLocal() {
  fs.writeFileSync(path.join(dir, "local-commit.md"), "unpublished source commit\n");
  git(dir, ["add", "."]); git(dir, ["commit", "-m", "unpublished source work"]);
}

function holdProjectLease() {
  const gitDir = path.join(paths.root, "git-source-switch-locks", slug, `${project}.git`);
  fs.mkdirSync(gitDir, { recursive: true });
  const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: dir, gitDir });
  if (!lease) throw new Error("isolated project lease fixture is unexpectedly busy");
  return lease;
}

describe.each(["gitea", "github"] as const)("held user preparation preserves transported %s projects", provider => {
  it.each(["ahead", "behind", "diverged", "detached"] as const)("preserves %s HEAD, index, dirty and untracked work without fetching or merging", async graph => {
    const fixture = wiring(provider);
    if (graph !== "behind") commitLocal();
    if (graph !== "ahead") advanceRemote();
    if (graph === "detached") git(dir, ["switch", "--detach", "HEAD"]);
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "staged identity\n"); git(dir, ["add", "IDENTITY.md"]);
    fs.writeFileSync(path.join(dir, "IDENTITY.md"), "unstaged identity after staging\n");
    fs.writeFileSync(path.join(dir, "README.md"), "dirty source work\n");
    fs.writeFileSync(path.join(dir, "untracked.md"), "untracked source work\n");
    const before = retainedState();

    await expect(fixture.gate.prepareSurgeTarget(fixture.request)).resolves.toBeUndefined();

    expect(retainedState()).toEqual(before);
    expect(fixture.clone).not.toHaveBeenCalled();
    expect(fixture.gitCalls).toEqual([]);
    expect(fixture.adapter.loadUserSnapshot).toHaveBeenCalledWith("uid-alice", { refresh: true });
    expect(fixture.processGate.status).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("preserves deletion of every tracked file without resurrecting them (staged=%s)", async staged => {
    const fixture = wiring(provider);
    for (const name of git(dir, ["ls-files"]).split("\n")) fs.unlinkSync(path.join(dir, name));
    if (staged) git(dir, ["add", "--update"]);
    const before = retainedState();

    await expect(fixture.gate.prepareSurgeTarget(fixture.request)).resolves.toBeUndefined();

    expect(retainedState()).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual([".git"]);
    expect(fixture.clone).not.toHaveBeenCalled();
  });

  it("does not acquire or disturb an active writer's mutation lease for a retained canonical checkout", async () => {
    const fixture = wiring(provider);
    const lease = holdProjectLease();
    try {
      await expect(fixture.gate.prepareSurgeTarget(fixture.request)).resolves.toBeUndefined();
      expect(fixture.clone).not.toHaveBeenCalled();
      expect(fixture.gitCalls).toEqual([]);
      expect(acquireWorkspaceMutationLeaseSync({ workspaceDir: dir,
        gitDir: path.join(paths.root, "git-source-switch-locks", slug, `${project}.git`) })).toBeNull();
    } finally { lease.release(); }
  });

  it("hydrates a genuinely absent checkout through the existing clone owner", async () => {
    const fixture = wiring(provider);
    fs.rmSync(dir, { recursive: true }); fs.rmSync(metadata, { recursive: true });
    fs.rmSync(`${metadata}.octogee-trusted-v3`);

    await expect(fixture.gate.prepareSurgeTarget(fixture.request)).resolves.toBeUndefined();

    expect(fixture.clone).toHaveBeenCalledOnce();
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("seed\n");
    expect(userRepositoryHasCanonicalRemote(dir)).toBe(true);
  });

  it("keeps preparation held when the imported source differs and the canonical replacement cannot clone", async () => {
    const fixture = wiring(provider, "clone");
    git(dir, ["remote", "set-url", "origin", "git@gitea:alice/foreign.git"]);
    fs.writeFileSync(`${metadata}.octogee-trusted-v3`, "octogee-customer-git-v3\ngitea:foreign\n");
    const before = retainedState();

    await expect(fixture.gate.prepareSurgeTarget(fixture.request)).rejects.toThrow("pending repositories: demo");

    expect(fixture.clone).toHaveBeenCalledOnce();
    expect(fixture.gitCalls.some(args => args[0] === "clone")).toBe(true);
    expect(retainedState()).toEqual(before);
    expect(fixture.processGate.status).toHaveBeenCalledOnce();
  });
});

it("does not hydrate projects after the owning request aborts during attach", async () => {
  const fixture = wiring();
  const controller = new AbortController();
  fixture.attach.mockImplementation(async () => { controller.abort(new Error("finish import cancelled")); return slug; });

  await expect(fixture.gate.prepareSurgeTarget(fixture.request, controller.signal)).rejects.toThrow("finish import cancelled");

  expect(fixture.clone).not.toHaveBeenCalled();
});
