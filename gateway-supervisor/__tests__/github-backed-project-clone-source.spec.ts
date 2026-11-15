import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "clone-source-openclaw-"));
process.env.OPENCLAW_DIR = openclawDir;

const gitMocks = vi.hoisted(() => ({
  cloneProjectRepo: vi.fn(async () => true),
  userRepositoryHasCanonicalRemote: vi.fn(() => false),
  projectCheckoutMatchesSource: vi.fn(() => false),
}));

vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return {
    ...actual,
    cloneProjectRepo: gitMocks.cloneProjectRepo,
    userRepositoryHasCanonicalRemote: gitMocks.userRepositoryHasCanonicalRemote,
    projectCheckoutMatchesSource: gitMocks.projectCheckoutMatchesSource,
  };
});

const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
const { CUSTOMERS_DIR } = await import("../lib/config.js");
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import type { FleetBrokerProjectRestore, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";

const GITHUB_REPO_SOURCE = { provider: "github", owner: "octogee-ai", repo: "demo" } as const;

function snapshot(projects: FleetBrokerProjectRestore[]): FleetBrokerUserSnapshot {
  return {
    uid: "uid-alice",
    slug: "alice",
    contextTemplateKey: "default",
    planInputs: { tier: "trial" },
    gatewayId: "builder-alice",
    status: "complete",
    agentIds: [],
    repoUrl: "",
    mattermostUserId: null,
    customerMmUserId: null,
    channels: [],
    projects,
    ownerName: "Alice",
    email: "",
    displayName: "",
    lastName: "",
    photoURL: "",
    persona: null,
    coachToken: null,
    defaultAgentMmUserId: null,
  };
}

function mkAdapter(projects: FleetBrokerProjectRestore[], log = vi.fn()) {
  const client = {
    uidForSlug: vi.fn(async () => "uid-alice"),
    userSnapshot: vi.fn(async () => snapshot(projects)),
  } as unknown as FleetBrokerClient;
  return {
    adapter: buildBrokeredLifecycleAdapter({ client, rpc: {} as GatewayRpcClient, log, projectCheckoutScope: () => "workspace-and-projects" }),
    log,
  };
}

beforeEach(() => {
  gitMocks.cloneProjectRepo.mockClear();
  gitMocks.userRepositoryHasCanonicalRemote.mockReset().mockReturnValue(false);
  gitMocks.projectCheckoutMatchesSource.mockReset().mockReturnValue(false);
  fs.rmSync(path.join(CUSTOMERS_DIR), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(openclawDir, { recursive: true, force: true });
});

describe("brokered adapter — GitHub-backed project checkout source", () => {
  it("carries a github repoSource into the needs-clone target", async () => {
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: null,
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "active",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "gh", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ]);
  });

  it("prefers the connected GitHub repo over the project's stale Gitea mirror", async () => {
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: "alice-gh",
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "active",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "gh", giteaRepoName: "alice-gh", repoSource: GITHUB_REPO_SOURCE },
    ]);
  });

  it("still skips a project that is not active", async () => {
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: null,
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "provisioning",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([]);
  });

  it("leaves a Gitea-backed project's target free of a repoSource", async () => {
    const { adapter } = mkAdapter([
      { projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "camp", giteaRepoName: "alice-camp" },
    ]);
  });

  it("keeps an active project with no checkout source pending, and says so", async () => {
    const { adapter, log } = mkAdapter([
      { projectSlug: "orphan", giteaRepoName: null, provisioningState: "active" },
      { projectSlug: "camp", giteaRepoName: "alice-camp", provisioningState: "active" },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "orphan", giteaRepoName: null },
      { projectSlug: "camp", giteaRepoName: "alice-camp" },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("alice/orphan"),
    );
    expect(log.mock.calls.flat().join("\n")).toMatch(
      /no Gitea repo and no GitHub repoSource/,
    );
  });

  it("keeps a source-less project pending even when stale local metadata appears canonical", async () => {
    gitMocks.projectCheckoutMatchesSource.mockReturnValue(true);
    const { adapter } = mkAdapter([
      { projectSlug: "orphan", giteaRepoName: null, provisioningState: "active" },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "orphan", giteaRepoName: null },
    ]);
  });

  it("ignores a repoSource whose provider is not github", async () => {
    const { adapter } = mkAdapter([
      {
        projectSlug: "camp",
        giteaRepoName: "alice-camp",
        repoSource: { provider: "gitlab", owner: "o", repo: "r" } as never,
        provisioningState: "active",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "camp", giteaRepoName: "alice-camp" },
    ]);
  });

  it("skips a project whose checkout is already on disk", async () => {
    fs.mkdirSync(path.join(CUSTOMERS_DIR, "alice", "projects", "gh", ".git"), { recursive: true });
    gitMocks.projectCheckoutMatchesSource.mockReturnValue(true);
    gitMocks.userRepositoryHasCanonicalRemote.mockReturnValue(true);
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: null,
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "active",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([]);
  });

  it("skips a project whose owner turned the checkout off — an unreachable repo must not strand the mount", async () => {
    const log = vi.fn();
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: null,
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "active",
        checkoutEnabled: false,
      },
    ], log);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/turned off by its owner/);
  });

  it("clones a project whose checkoutEnabled is absent — existing docs carry no flag and stay on", async () => {
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: null,
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "active",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      { projectSlug: "gh", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ]);
  });

  it("reconciles a checkout whose trusted source does not match the project source", async () => {
    fs.mkdirSync(path.join(CUSTOMERS_DIR, "alice", "projects", "gh", ".git"), { recursive: true });
    const { adapter } = mkAdapter([
      {
        projectSlug: "gh",
        giteaRepoName: "alice-gh",
        repoSource: { ...GITHUB_REPO_SOURCE },
        provisioningState: "active",
      },
    ]);

    await expect(adapter.listProjectsNeedingClone("alice")).resolves.toEqual([
      {
        projectSlug: "gh",
        giteaRepoName: "alice-gh",
        repoSource: GITHUB_REPO_SOURCE,
      },
    ]);
  });

  it("forwards the repoSource to the clone and passes no explicit GitHub token — the clone rides the pod's ambient gh credential helper", async () => {
    const { adapter } = mkAdapter([]);

    await adapter.cloneProjectRepo("alice", "gh", null, { repoSource: { ...GITHUB_REPO_SOURCE } });

    expect(gitMocks.cloneProjectRepo).toHaveBeenCalledWith("alice", "gh", "", {
      repoSource: GITHUB_REPO_SOURCE,
    });
  });

  it("clones a Gitea-backed project with its repo name and no clone options", async () => {
    const { adapter } = mkAdapter([]);

    await adapter.cloneProjectRepo("alice", "camp", "alice-camp");

    expect(gitMocks.cloneProjectRepo).toHaveBeenCalledWith("alice", "camp", "alice-camp", undefined);
  });
});
