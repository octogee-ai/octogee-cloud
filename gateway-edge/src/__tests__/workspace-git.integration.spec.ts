import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const firestoreData = vi.hoisted(() => ({}) as Record<string, any>);

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(firestoreData) };
});

vi.mock("@octogee/core/internal-brokers/workspace-git-authorization-broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octogee/core/internal-brokers/workspace-git-authorization-broker")>();
  const { resolveFileTarget } = await import("@octogee/core/workspace/fileTarget");
  const { resolveCanonicalWorkspaceSlug } = await import("@octogee/core/workspace/canonical-workspace");
  const { resolveCommitAuthor } = await import("@octogee/core/workspace/route-helpers");
  const { accountAllowsInteractiveAccess } = await import("@octogee/shared/types/account-lifecycle");
  const authorizeWorkspaceGit: typeof actual.authorizeWorkspaceGit = async (args) => {
    if (!args.authorization?.startsWith("Bearer ")) return { kind: "unauthenticated" };
    const uid = "caller-uid";
    const user = firestoreData[`users/${uid}`];
    if (!user || !accountAllowsInteractiveAccess(user)) {
      return { kind: "denied", status: 403, error: "Account is not active" };
    }
    const callerWorkspaceSlug = await resolveCanonicalWorkspaceSlug(uid, user);
    const result = await resolveFileTarget(
      { slug: args.slug, projectSlug: args.projectSlug, callerUid: uid, callerWorkspaceSlug },
      args.lane,
    );
    if (!result.ok) {
      return { kind: "denied", status: result.status, error: result.error, ...(result.reason ? { reason: result.reason } : {}) };
    }
    return {
      kind: "authorized",
      authorization: {
        gatewayId: args.gatewayId,
        uid,
        slug: args.slug,
        projectSlug: args.projectSlug,
        githubToken: result.target.githubToken ?? null,
        commitAuthor: resolveCommitAuthor(user, args.slug),
      },
    };
  };
  return { ...actual, authorizeWorkspaceGit };
});

vi.mock("../../../platform-api/src/lib/mattermost", () => ({
  mmApi: vi.fn(),
  MM_URL: "http://mattermost-test:8065",
}));

vi.mock("@octogee/core/git-host/gitea-client", () => ({
  giteaApi: vi.fn(),
  giteaApiAllowNotFound: vi.fn(),
  giteaApiAs: vi.fn(),
  giteaApiAsAllowNotFound: vi.fn(),
  GITEA_ORG: "octogee-test",
  GITEA_URL: "http://gitea.test:3000",
  getToken: vi.fn(() => "gitea-token"),
}));

import { createApp } from "../index.js";
import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { workspaceMutationLeaseGitDir } from "@octogee/core/workspace/workspace-git";
import workspaceGitRoutes from "../routes/workspace/git.js";
import { installDocumentUserAccounts } from "./helpers/user-accounts.js";

installDocumentUserAccounts((uid) => firestoreData[`users/${uid}`]);

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

function routeSignatures(router: unknown): string[] {
  const stack = (router as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route;
      if (!route) throw new Error("expected route layer");
      const methods = Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase())
        .sort()
        .join(",");
      return `${methods} ${route.path}`;
    });
}

function gitInit(dir: string): void {
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@x.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
}

function gitAddCommit(dir: string, msg: string): void {
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", msg], { cwd: dir });
}

async function externalizeUserGitMetadata(
  dir: string,
  metadataDir: string,
  remoteUrl: string,
): Promise<void> {
  spawnSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  await fs.mkdir(path.dirname(metadataDir), { recursive: true });
  await fs.rename(path.join(dir, ".git"), metadataDir);
  await fs.writeFile(path.join(dir, ".git"), `gitdir: ${metadataDir}\n`);
  const giteaMatch = /^git@gitea:[^/]+\/(.+)\.git$/u.exec(remoteUrl);
  const githubMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/u.exec(remoteUrl);
  const source = giteaMatch
    ? `gitea:${giteaMatch[1]}`
    : githubMatch
      ? `github:${githubMatch[1]}/${githubMatch[2]}`
      : null;
  if (!source) throw new Error(`unexpected test remote: ${remoteUrl}`);
  await fs.writeFile(
    `${metadataDir}.octogee-trusted-v3`,
    `octogee-customer-git-v3\n${source}\n`,
  );
}

let testRoot: string;
let usersRoot: string;
const SLUG = "joe42";

beforeAll(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wsroot-int-"));
  usersRoot = path.join(testRoot, "customers");
  await fs.mkdir(usersRoot);
  process.env.CUSTOMERS_DIR = usersRoot;
  process.env.GATEWAY_ID = "walter";
  const slugDir = path.join(usersRoot, SLUG);
  await fs.mkdir(slugDir);
  gitInit(slugDir);
  await fs.writeFile(path.join(slugDir, "README.md"), "hello\n");
  gitAddCommit(slugDir, "initial");
  await externalizeUserGitMetadata(
    slugDir,
    path.join(testRoot, "git-metadata", SLUG, "workspace.git"),
    `git@gitea:${SLUG}/workspace.git`,
  );
});

afterAll(async () => {
  delete process.env.GATEWAY_ID;
  await fs.rm(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
  firestoreData[`users/caller-uid`] = {
    uid: "caller-uid",
    username: SLUG,
    workspaceId: SLUG,
    subscription: { tier: "personal", status: "active" },
  };
  firestoreData[`users/caller-uid/system/config`] = { role: "user" };
  firestoreData[`workspaces/${SLUG}`] = { id: SLUG, ownerUid: "caller-uid", slug: SLUG };
});

describe("workspace git route module", () => {
  it("exports the git endpoints covered by this integration suite", () => {
    expect(routeSignatures(workspaceGitRoutes)).toEqual([
      "GET /git/status",
      "GET /git/diff",
      "GET /git/commit-diff",
      "GET /git/log",
      "GET /git/branches",
      "POST /git/commit",
      "POST /git/push",
      "POST /git/branch/checkout",
    ]);
  });
});

describe("GET /api/workspace/git/status", () => {
  it("returns clean tree as empty entries", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it("returns modified file when working tree has changes", async () => {
    await fs.writeFile(path.join(usersRoot, SLUG, "README.md"), "modified\n");
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ path: "README.md", change: "modified" }]);
    
    await fs.writeFile(path.join(usersRoot, SLUG, "README.md"), "hello\n");
  });

  it("returns 503 + CUSTOMER_DIR_MISSING when slug isn't on the filesystem", async () => {
    firestoreData[`users/caller-uid`] = { uid: "caller-uid", username: "ghost", workspaceId: "ghost" };
    firestoreData[`workspaces/ghost`] = { id: "ghost", ownerUid: "caller-uid", slug: "ghost" };
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=ghost`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CUSTOMER_DIR_MISSING");
  });

  it("returns 403 when caller is not the workspace owner", async () => {
    firestoreData[`users/caller-uid`] = { uid: "caller-uid", username: "other", workspaceId: "other" };
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/workspace/git/diff", () => {
  it("returns the unified diff text/plain for a modified file", async () => {
    await fs.writeFile(path.join(usersRoot, SLUG, "README.md"), "changed\n");
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/diff?slug=${SLUG}&path=README.md`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("--- a/README.md");
    expect(res.text).toContain("+changed");
    await fs.writeFile(path.join(usersRoot, SLUG, "README.md"), "hello\n");
  });

  it("rejects path traversal with 400", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/diff?slug=${SLUG}&path=../etc/passwd`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_PATH");
  });

  it("rejects ref names with shell metacharacters with 400", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/diff?slug=${SLUG}&ref=main;rm -rf /`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REF");
  });

  it("rejects ref names that start with a dash (would be parsed as a flag)", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/diff?slug=${SLUG}&ref=-deadbeef`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REF");
  });
});

describe("GET /api/workspace/git/log", () => {
  it("returns the initial commit for a fresh repo", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/log?slug=${SLUG}&limit=5`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].subject).toBe("initial");
    expect(res.body.entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects branch names with shell metacharacters", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/log?slug=${SLUG}&branch=main$(whoami)`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_BRANCH");
  });
});

describe("project working tree (Phase 6.C.3 — ?project=)", () => {

const PROJECT = "myproj";
  beforeAll(async () => {
    const projectsParent = path.join(usersRoot, SLUG, "projects");
    await fs.mkdir(projectsParent, { recursive: true });
    const projectDir = path.join(projectsParent, PROJECT);
    await fs.mkdir(projectDir);
    gitInit(projectDir);
    await fs.writeFile(path.join(projectDir, "PROJECT.md"), "project init\n");
    gitAddCommit(projectDir, "project initial");
    await externalizeUserGitMetadata(
      projectDir,
      path.join(testRoot, "git-metadata", SLUG, "projects", `${PROJECT}.git`),
      `git@gitea:${SLUG}/${PROJECT}.git`,
    );
  });
  beforeEach(() => {
    firestoreData[`workspaces/${SLUG}/projects/${PROJECT}`] = {
      slug: PROJECT,
      ownerUid: "caller-uid",
    };
  });

  it("/git/status returns the project's working tree (no longer rejects ?project=)", async () => {
    await fs.writeFile(
      path.join(usersRoot, SLUG, "projects", PROJECT, "PROJECT.md"),
      "edited from inside project\n",
    );
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}&project=${PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([{ path: "PROJECT.md", change: "modified" }]);
    
    await fs.writeFile(
      path.join(usersRoot, SLUG, "projects", PROJECT, "PROJECT.md"),
      "project init\n",
    );
  });

  it("/git/diff resolves against the project tree, not the workspace tree", async () => {
    await fs.writeFile(
      path.join(usersRoot, SLUG, "projects", PROJECT, "PROJECT.md"),
      "diff me\n",
    );
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/diff?slug=${SLUG}&project=${PROJECT}&path=PROJECT.md`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.text).toContain("--- a/PROJECT.md");
    expect(res.text).toContain("+diff me");
    await fs.writeFile(
      path.join(usersRoot, SLUG, "projects", PROJECT, "PROJECT.md"),
      "project init\n",
    );
  });

  it("/git/log returns the project repo's history (not the parent workspace's)", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/log?slug=${SLUG}&project=${PROJECT}&limit=5`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].subject).toBe("project initial");
  });

  it("/git/branches lists the project repo's local branches", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/branches?slug=${SLUG}&project=${PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("main");
  });

  it("/git/branch/checkout creates and switches a branch on the project tree", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}&project=${PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "feat/proj-work", create: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, branch: "feat/proj-work" });
    
    await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}&project=${PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "main" });
  });

  it("project-member who is NOT the workspace owner can read the project tree", async () => {
    
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "ghost",
      workspaceId: "ghost",
    };
    firestoreData[`workspaces/${SLUG}/projects/${PROJECT}`] = {
      slug: PROJECT,
      ownerUid: "different-uid",
    };
    firestoreData[`workspaces/${SLUG}/projects/${PROJECT}/members/caller-uid`] = {
      uid: "caller-uid",
      role: "member",
    };
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}&project=${PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(200);
  });

  it("non-owner / non-member is still 403'd by the authorization broker", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "ghost",
      workspaceId: "ghost",
    };
    firestoreData[`workspaces/${SLUG}/projects/${PROJECT}`] = {
      slug: PROJECT,
      ownerUid: "different-uid",
    };
    
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}&project=${PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(403);
  });
});

describe("GitHub-backed project working tree", () => {
  const GH_PROJECT = "ghproj";
  beforeAll(async () => {
    const projectDir = path.join(usersRoot, SLUG, "projects", GH_PROJECT);
    await fs.mkdir(projectDir, { recursive: true });
    gitInit(projectDir);
    await fs.writeFile(path.join(projectDir, "GH.md"), "from github\n");
    gitAddCommit(projectDir, "github initial");
    await externalizeUserGitMetadata(
      projectDir,
      path.join(testRoot, "git-metadata", SLUG, "projects", `${GH_PROJECT}.git`),
      "https://github.com/octogee-ai/demo.git",
    );
  });
  beforeEach(() => {
    firestoreData[`workspaces/${SLUG}/projects/${GH_PROJECT}`] = {
      slug: GH_PROJECT,
      ownerUid: "caller-uid",
      giteaRepoName: null,
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
    };
  });

  it("/git/status serves the local checkout instead of refusing the github provider", async () => {
    await fs.writeFile(
      path.join(usersRoot, SLUG, "projects", GH_PROJECT, "GH.md"),
      "edited\n",
    );
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/status?slug=${SLUG}&project=${GH_PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status, res.text).toBe(200);
    expect(res.body.entries).toEqual([{ path: "GH.md", change: "modified" }]);
  });

  it("/git/commit writes a commit to the github-backed checkout", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}&project=${GH_PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "github-backed commit" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.empty).toBe(false);
    expect(res.body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("rejects a project commit while source reconciliation holds the shared mutation fence", async () => {
    const projectDir = path.join(usersRoot, SLUG, "projects", GH_PROJECT);
    const lease = acquireWorkspaceMutationLeaseSync({
      workspaceDir: projectDir,
      gitDir: workspaceMutationLeaseGitDir(projectDir),
    });
    expect(lease).not.toBeNull();
    try {
      const res = await request(createApp())
        .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}&project=${GH_PROJECT}`)
        .set("Authorization", "Bearer caller-idtoken")
        .send({ message: "must wait" });
      expect(res.status, res.text).toBe(409);
      expect(res.body.code).toBe("WORKSPACE_BUSY");
    } finally {
      lease?.release();
    }
  });

  it("/git/branch/checkout switches branches on the github-backed checkout", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}&project=${GH_PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "feat/gh-work", create: true });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ ok: true, branch: "feat/gh-work" });
    await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}&project=${GH_PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "main" });
  });

  it("still 403s a caller who is neither project owner nor project member", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "ghost",
      workspaceId: "ghost",
    };
    firestoreData[`workspaces/${SLUG}/projects/${GH_PROJECT}`] = {
      slug: GH_PROJECT,
      ownerUid: "different-uid",
      repoSource: { provider: "github", owner: "octogee-ai", repo: "demo" },
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}&project=${GH_PROJECT}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "not mine" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/workspace/git/commit (Phase 6.C.2)", () => {
  it("commits a real working-tree change with the requesting user as author", async () => {
    
    await fs.writeFile(path.join(usersRoot, SLUG, "README.md"), "owner change\n");
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: SLUG,
      workspaceId: SLUG,
      displayName: "Bob Owner",
      email: "bob@example.com",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "Owner-driven change" });
    expect(res.status).toBe(200);
    expect(res.body.empty).toBe(false);
    expect(res.body.sha).toMatch(/^[0-9a-f]{40}$/);

const last = spawnSync("git", ["log", "-1", "--pretty=format:%ae"], {
      cwd: path.join(usersRoot, SLUG),
      encoding: "utf-8",
    });
    expect(last.stdout.trim()).toBe("bob@example.com");

await fs.writeFile(path.join(usersRoot, SLUG, "README.md"), "hello\n");
    spawnSync("git", ["add", "."], { cwd: path.join(usersRoot, SLUG) });
    spawnSync("git", ["commit", "-m", "restore"], { cwd: path.join(usersRoot, SLUG) });
  });

  it("returns 200 with empty: true for clean working tree (idempotent — no error)", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "nothing to commit" });
    expect(res.status).toBe(200);
    expect(res.body.empty).toBe(true);
  });

  it("rejects empty message with 400 BAD_MESSAGE", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "   " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_MESSAGE");
  });

  it("rejects 5001-char message with 400 MESSAGE_TOO_LONG", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "x".repeat(5_001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MESSAGE_TOO_LONG");
  });

  it("returns 403 when caller is not the workspace owner (authorization broker primary gate)", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "someone-else",
      workspaceId: "someone-else",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "not my workspace" });
    expect(res.status).toBe(403);
  });

  it("project member of workspace A cannot write the WORKSPACE tree of A (#840 auth-bypass guard, retained under 6.C.3)", async () => {

firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "ghost",
      workspaceId: "ghost",
    };
    firestoreData[`workspaces/${SLUG}/projects/myproj`] = {
      slug: "myproj",
      ownerUid: "different-uid",
    };
    firestoreData[`workspaces/${SLUG}/projects/myproj/members/caller-uid`] = {
      uid: "caller-uid",
      role: "member",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/commit?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ message: "trying to write workspace tree as a project member" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/workspace/git/push (Phase 6.C.2)", () => {
  it("returns 403 for non-owner callers (authorization broker primary gate)", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "someone-else",
      workspaceId: "someone-else",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/push?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(403);
  });

  it("rejects unsafe branch ref names with 400 BAD_BRANCH", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/push?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "-deletes-everything" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_BRANCH");
  });
});

describe("POST /api/workspace/git/branch/checkout (Phase 6.C.3)", () => {
  it("rejects unsafe branch ref names with 400 BAD_BRANCH", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "; rm -rf /" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_BRANCH");
  });

  it("rejects empty body with 400 BAD_BRANCH", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_BRANCH");
  });

  it("returns 403 for non-owner callers on workspace target", async () => {
    firestoreData[`users/caller-uid`] = {
      uid: "caller-uid",
      username: "someone-else",
      workspaceId: "someone-else",
    };
    const app = createApp();
    const res = await request(app)
      .post(`/api/g/walter/workspace/git/branch/checkout?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken")
      .send({ branch: "main" });
    expect(res.status).toBe(403);
  });
});

describe("concurrency cap (P1-1)", () => {
  it("returns 429 CONCURRENCY_LIMIT when more than 4 in-flight git ops for the same slug", async () => {
    const app = createApp();
    
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .get(`/api/g/walter/workspace/git/status?slug=${SLUG}`)
          .set("Authorization", "Bearer caller-idtoken"),
      ),
    );
    const statuses = responses.map((r) => r.status);
    const ok = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    expect(ok + limited).toBe(6);
    expect(limited).toBeGreaterThan(0);
    for (const r of responses) {
      if (r.status === 429) {
        expect(r.body.code).toBe("CONCURRENCY_LIMIT");
      }
    }
  });
});

describe("GET /api/workspace/git/commit-diff", () => {
  it("returns the unified diff introduced by a specific commit", async () => {
    const slugDir = path.join(usersRoot, SLUG);
    await fs.writeFile(path.join(slugDir, "FEATURE.md"), "shiny new line\n");
    gitAddCommit(slugDir, "add FEATURE.md");
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: slugDir, encoding: "utf-8" }).stdout.trim();

    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/commit-diff?slug=${SLUG}&commit=${sha}`)
      .set("Authorization", "Bearer caller-idtoken");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("+++ b/FEATURE.md");
    expect(res.text).toContain("+shiny new line");
    // No commit-message header leaks into the diff payload.
    expect(res.text).not.toContain("add FEATURE.md");
  });

  it("rejects a commit ref with shell metacharacters with 400 BAD_REF", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/commit-diff?slug=${SLUG}&commit=abc123;rm -rf /`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REF");
  });

  it("rejects a missing commit param with 400 BAD_REF", async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/commit-diff?slug=${SLUG}`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REF");
  });

  it("returns 403 when caller is not the workspace owner", async () => {
    firestoreData[`users/caller-uid`] = { uid: "caller-uid", username: "other", workspaceId: "other" };
    const app = createApp();
    const res = await request(app)
      .get(`/api/g/walter/workspace/git/commit-diff?slug=${SLUG}&commit=HEAD`)
      .set("Authorization", "Bearer caller-idtoken");
    expect(res.status).toBe(403);
  });
});
