import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { gitHost } from "../lib/git-host.js";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { createInternalGiteaAdminRoutes } from "../routes/internal/gitea-admin.js";
import { createLegacyProvisioning, type LegacyProvisioning, type LegacyProvisioningClient } from "../lib/legacy-provisioning.js";
import type { GitKey } from "@octogee/shared/types/provisioning-service";
import { logger } from "@octogee/core/http/logging";

const mocks = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(mocks.docs) };
});

vi.mock("../lib/git-host.js", () => {
  const host = {
    releaseKey: vi.fn(async () => {}),
    registerKey: vi.fn(async () => {}),
    registerKeyUnlessHeld: vi.fn(async () => {}),
    primaryKey: vi.fn(async () => "ssh-ed25519 OLD predecessor"),
    listKeys: vi.fn(async () => ["ssh-ed25519 OLD predecessor", "ssh-ed25519 KEY octogee"]),
    ensureOwner: vi.fn(async () => {}),
    ensureRepo: vi.fn(async () => {}),
    repoExists: vi.fn(async () => true),
    archiveRepo: vi.fn(async () => {}),
  };
  return { gitHost: () => host };
});

const projectProvisioning = vi.hoisted(() => ({
  ensureProjectGiteaRepo: vi.fn(async () => ({ created: true })),
  deleteProjectGiteaRepo: vi.fn(async () => {}),
}));

vi.mock("../routes/projects/provisioning.js", () => ({
  ensureProjectGiteaRepo: (...args: unknown[]) => projectProvisioning.ensureProjectGiteaRepo(...args),
  deleteProjectGiteaRepo: (...args: unknown[]) => projectProvisioning.deleteProjectGiteaRepo(...args),
  ProjectRepoProvisioningError: class ProjectRepoProvisioningError extends Error {},
}));

function app(
  boundGatewayId: string | null = "walter",
  podGatewayId: string | null = "walter",
  legacyProvisioning: LegacyProvisioning | null = null,
) {
  const a = express();
  a.use(express.json());
  if (boundGatewayId) {
    a.use((req, _res, next) => {
      req.boundTenant = {
        kind: "gateway",
        gatewayId: boundGatewayId,
        ownerUid: `owner-${boundGatewayId}`,
        ...(podGatewayId
          ? { podName: `octogee-gateway-${podGatewayId}-5bc5949d46-p946t` }
          : {}),
      };
      next();
    });
  }
  a.use("/internal/gitea", createInternalGiteaAdminRoutes({ legacyProvisioning }));
  return a;
}

function isolatedGateway(overrides: Record<string, unknown> = {}) {
  return {
    gatewayId: "walter",
    createdAt: 1,
    createdBy: "admin",
    updatedAt: 2,
    updatedBy: "admin",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-walter",
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "owner-walter",
    builderSlug: "acme",
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function assignUser(slug: string, gatewayId: string) {
  mocks.docs.set(`users/uid-${slug}`, {
    username: slug,
    provisioning: { openclaw: { slug, gatewayId } },
  });
}

function seedRunningMigration(uid: string, toGatewayId: string) {
  mocks.docs.set("glmOperations/op-1", {
    kind: "migrate-user",
    status: "running",
    gatewayId: toGatewayId,
    inputUid: uid,
    input: { uid, toGatewayId },
    createdBy: "admin",
    createdAt: 1,
    updatedAt: 1,
  });
}

function authed(req: request.Test) {
  // Auth is the gateway tenant-binding injected by app(); the legacy
  // internal-service-key is retired.
  return req;
}

const WALTER_KEY_OWNER = "walter/octogee-gateway-walter-5bc5949d46-p946t";

describe("internal gitea-admin route", () => {
  beforeEach(() => {
    process.env.GATEWAY_ID = "walter";
    vi.clearAllMocks();
    mocks.docs.clear();
    assignUser("acme", "walter");
    vi.spyOn(platformStateStore.users.records, "listByGateway");
    vi.spyOn(platformStateStore.users.records, "findBySlug");
    vi.spyOn(platformStateStore.journal.operations, "listForUid");
    projectProvisioning.ensureProjectGiteaRepo.mockReset().mockResolvedValue({ created: true });
    projectProvisioning.deleteProjectGiteaRepo.mockReset().mockResolvedValue(undefined);
  });

  it("rejects requests without a bound gateway identity (401)", async () => {
    const res = await request(app(null)).post("/internal/gitea/ensure-user").send({ slug: "acme", pubKey: "k" });
    expect(res.status).toBe(401);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("ensure-user → 204 and calls the lib with slug + pubKey", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(204);
    expect(platformStateStore.users.records.listByGateway).toHaveBeenCalledWith("walter");
    expect(gitHost().registerKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      WALTER_KEY_OWNER,
    );
  });

  it("release-user-key removes only the authenticated gateway pod's submitted key", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/release-user-key"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 OLD predecessor" });
    expect(res.status).toBe(204);
    expect(gitHost().releaseKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 OLD predecessor",
      WALTER_KEY_OWNER,
    );
  });

  it("lets a predecessor pod release only its owner-bound key after cutover", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/release-user-key"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 OLD predecessor" });

    expect(res.status).toBe(204);
    expect(platformStateStore.users.records.listByGateway).not.toHaveBeenCalled();
    expect(gitHost().releaseKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 OLD predecessor",
      WALTER_KEY_OWNER,
    );
  });

  it("uses the bound gateway identity from octogee-api TokenReview instead of GATEWAY_ID env", async () => {
    delete process.env.GATEWAY_ID;
    delete process.env.INTERNAL_SERVICE_KEY;

    const res = await request(app("walter"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(platformStateStore.users.records.listByGateway).toHaveBeenCalledWith("walter");
    expect(gitHost().registerKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      WALTER_KEY_OWNER,
    );
  });

  it("ensure-user → 403 when slug is not assigned to this gateway, before touching Gitea", async () => {
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "victim", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(403);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("allows the target gateway during a running inbound user migration", async () => {
    assignUser("acme", "other-gateway");
    seedRunningMigration("uid-acme", "walter");

    const res = await authed(
      request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }),
    );

    expect(res.status).toBe(200);
    expect(platformStateStore.journal.operations.listForUid).toHaveBeenCalledWith("uid-acme", {
      kind: "migrate-user",
      statuses: ["running"],
    });
    expect(gitHost().primaryKey).toHaveBeenCalledWith("acme");
  });

  it("allows the authenticated stable gateway pod to bootstrap its configured user", async () => {
    mocks.docs.delete("users/uid-acme");
    mocks.docs.set("gateways/walter", isolatedGateway());

    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(gitHost().registerKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      WALTER_KEY_OWNER,
    );
  });

  it("leaves the key of a user another gateway serves with that gateway when the configured gateway boots", async () => {
    assignUser("acme", "shared-1");
    mocks.docs.set("gateways/walter", isolatedGateway());

    const res = await request(app())
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
    expect(gitHost().registerKeyUnlessHeld).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      WALTER_KEY_OWNER,
    );
  });

  it("lets the configured gateway claim the key once an inbound migration targets it", async () => {
    assignUser("acme", "shared-1");
    mocks.docs.set("gateways/walter", isolatedGateway());
    seedRunningMigration("uid-acme", "walter");

    const res = await request(app())
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(gitHost().registerKeyUnlessHeld).not.toHaveBeenCalled();
    expect(gitHost().registerKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      WALTER_KEY_OWNER,
    );
  });

  it("denies a pod outside the gateway's own Deployment from bootstrapping the configured user", async () => {
    mocks.docs.delete("users/uid-acme");
    mocks.docs.set("gateways/walter", isolatedGateway());

    const res = await request(app("walter", "other"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(403);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("allows the initial stable pod before the gateway has a live release", async () => {
    mocks.docs.delete("users/uid-acme");
    mocks.docs.set("gateways/walter", isolatedGateway({
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: null,
      liveRevisionId: null,
      trafficRevisionId: null,
    }));

    const res = await request(app("walter", "walter"))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(gitHost().registerKey).toHaveBeenCalledWith(
      "acme",
      "ssh-ed25519 AAA",
      WALTER_KEY_OWNER,
    );
  });

  it("denies bootstrap without an authenticated pod identity", async () => {
    mocks.docs.delete("users/uid-acme");
    mocks.docs.set("gateways/walter", isolatedGateway());

    const res = await request(app("walter", null))
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(403);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it.each([
    { desiredStatus: "paused" },
    { desiredStatus: "draining" },
    { desiredStatus: "retired" },
    { retireAfter: 10 },
    { retirementClaim: { operationId: "retire-1", version: 1 } },
  ])("denies configured-user bootstrap after lifecycle revocation: %o", async (override) => {
    mocks.docs.delete("users/uid-acme");
    mocks.docs.set("gateways/walter", isolatedGateway(override));

    const res = await request(app())
      .post("/internal/gitea/ensure-user")
      .send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(403);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("denies unassigned slugs when no inbound migration targets this gateway", async () => {
    assignUser("acme", "other-gateway");
    seedRunningMigration("uid-acme", "third-gateway");

    const res = await authed(
      request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }),
    );

    expect(res.status).toBe(403);
    expect(platformStateStore.journal.operations.listForUid).toHaveBeenCalledWith("uid-acme", {
      kind: "migrate-user",
      statuses: ["running"],
    });
    expect(gitHost().primaryKey).not.toHaveBeenCalled();
  });

  it("ensure-user → 502 when assignment lookup fails, before touching Gitea", async () => {
    vi.mocked(platformStateStore.users.records.listByGateway).mockRejectedValueOnce(new Error("firestore down"));
    const res = await authed(
      request(app()).post("/internal/gitea/ensure-user"),
    ).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(502);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("ensure-user → 400 when pubKey missing", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug: "acme" });
    expect(res.status).toBe(400);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("user-pubkey keeps the singular response for a predecessor image during a roll", async () => {
    const res = await authed(request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pubKey: "ssh-ed25519 OLD predecessor" });
    expect(gitHost().primaryKey).toHaveBeenCalledWith("acme");
  });

  it("user-pubkey → 200 { pubKey: null } when no managed key exists", async () => {
    vi.mocked(gitHost().primaryKey).mockResolvedValueOnce(null);
    const res = await authed(request(app()).get("/internal/gitea/user-pubkey").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pubKey: null });
  });

  it("user-pubkeys → 200 { pubKeys } for surge-safe membership checks", async () => {
    const res = await authed(request(app()).get("/internal/gitea/user-pubkeys").query({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pubKeys: ["ssh-ed25519 OLD predecessor", "ssh-ed25519 KEY octogee"],
    });
    expect(gitHost().listKeys).toHaveBeenCalledWith("acme");
  });

  it("ensure-org → 204 and calls the lib with slug", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-org")).send({ slug: "acme" });
    expect(res.status).toBe(204);
    expect(gitHost().ensureOwner).toHaveBeenCalledWith("acme");
  });

  it("ensure-workspace-repo → 204", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-workspace-repo")).send({ slug: "acme" });
    expect(res.status).toBe(204);
    expect(gitHost().ensureRepo).toHaveBeenCalledWith("acme", { kind: "workspace" });
  });

  it("ensure-system-config-repo → 204", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-system-config-repo")).send({ slug: "acme" });
    expect(res.status).toBe(204);
    expect(gitHost().ensureRepo).toHaveBeenCalledWith("acme", { kind: "system-config" });
  });

  it("provisions the private agent repository only through its owner-scoped route", async () => {
    const server = request(app());
    const denied = await authed(server.post("/internal/gitea/ensure-project-coach-repo")).send({ slug: "other" });
    expect(denied.status).toBe(403);
    const ordinary = await authed(server.post("/internal/gitea/ensure-project-repo")).send({ slug: "acme", projectName: "project_coaches" });
    expect(ordinary.status).toBe(400);
    const allowed = await authed(server.post("/internal/gitea/ensure-project-coach-repo")).send({ slug: "acme" });
    expect(allowed.status).toBe(204);
    expect(gitHost().ensureRepo).toHaveBeenCalledExactlyOnceWith("acme", { kind: "project-coaches" });
  });

  it("ensure-project-repo → 204 with slug + projectName", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-project-repo")).send({
      slug: "acme",
      projectName: "mygame",
    });
    expect(res.status).toBe(204);
    expect(gitHost().ensureRepo).toHaveBeenCalledWith("acme", { kind: "project", projectSlug: "mygame" });
  });

  it("provision-project-repo seeds through the assigned gateway's API broker", async () => {
    const input = {
      workspaceId: "acme",
      slug: "mygame",
      name: "My game",
      tagline: "Ship it",
      projectType: "web",
      visibility: "private",
      recipe: "vite-static",
    };
    const res = await authed(request(app()).post("/internal/gitea/provision-project-repo")).send(input);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: true });
    expect(projectProvisioning.ensureProjectGiteaRepo).toHaveBeenCalledWith({ ...input, githubBacked: false });
  });

  it("provision-project-repo resolves the type default when a pre-recipe sender omits it", async () => {
    const res = await authed(request(app()).post("/internal/gitea/provision-project-repo")).send({
      workspaceId: "acme",
      slug: "mygame",
      name: "My game",
      tagline: "Ship it",
      projectType: "game",
      visibility: "private",
    });

    expect(res.status).toBe(200);
    expect(projectProvisioning.ensureProjectGiteaRepo).toHaveBeenCalledWith(
      expect.objectContaining({ projectType: "game", recipe: "vite-static" }),
    );
  });

  it("provision-project-repo → 400 on a recipe outside the catalog, before touching Gitea", async () => {
    const res = await authed(request(app()).post("/internal/gitea/provision-project-repo")).send({
      workspaceId: "acme",
      slug: "mygame",
      name: "My game",
      tagline: "Ship it",
      projectType: "game",
      visibility: "private",
      recipe: "node-service",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/static-site, vite-static, astro-static/);
    expect(projectProvisioning.ensureProjectGiteaRepo).not.toHaveBeenCalled();
  });

  it("delete-project-repo is scoped to the assigned workspace", async () => {
    const res = await authed(request(app()).post("/internal/gitea/delete-project-repo")).send({
      workspaceId: "acme",
      slug: "mygame",
    });

    expect(res.status).toBe(204);
    expect(projectProvisioning.deleteProjectGiteaRepo).toHaveBeenCalledWith({
      workspaceId: "acme",
      slug: "mygame",
    });
  });

  it("repo-exists → 200 { exists }", async () => {
    const res = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "workspace" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true });
    expect(gitHost().repoExists).toHaveBeenCalledWith({ owner: "acme", repo: "workspace" });
  });

  it("repo-exists accepts only the fixed system_config repo underscore exception", async () => {
    const ok = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "system_config" }));
    expect(ok.status).toBe(200);
    expect(gitHost().repoExists).toHaveBeenCalledWith({ owner: "acme", repo: "system_config" });

    const bad = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "not_config" }));
    expect(bad.status).toBe(400);
  });

  it("archive-repo → 204 with org + repo", async () => {
    const res = await authed(request(app()).post("/internal/gitea/archive-repo")).send({ org: "acme", repo: "workspace" });
    expect(res.status).toBe(204);
    expect(gitHost().archiveRepo).toHaveBeenCalledWith({ owner: "acme", repo: "workspace" });
  });

  it("archive-repo → 403 when org is not assigned to this gateway, before touching Gitea", async () => {
    const res = await authed(request(app()).post("/internal/gitea/archive-repo")).send({ org: "victim", repo: "workspace" });
    expect(res.status).toBe(403);
    expect(gitHost().archiveRepo).not.toHaveBeenCalled();
  });

  it("→ 502 when the lib throws (fail loud, no silent success)", async () => {
    vi.mocked(gitHost().registerKey).mockRejectedValueOnce(new Error("gitea down"));
    const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/gitea down/);
  });

  it("rejects path-traversal / malformed slug with 400 — never reaches the admin lib", async () => {
    for (const slug of ["../admin", "ws/../../x", "Acme", "a b", ""]) {
      const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug, pubKey: "ssh-ed25519 AAA" });
      expect(res.status, `slug=${JSON.stringify(slug)}`).toBe(400);
    }
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("rejects a non-SSH pubKey with 400", async () => {
    const res = await authed(request(app()).post("/internal/gitea/ensure-user")).send({ slug: "acme", pubKey: "not-a-key" });
    expect(res.status).toBe(400);
    expect(gitHost().registerKey).not.toHaveBeenCalled();
  });

  it("rejects malformed projectName / org / repo with 400", async () => {
    const r1 = await authed(request(app()).post("/internal/gitea/ensure-project-repo")).send({ slug: "acme", projectName: "../x" });
    expect(r1.status).toBe(400);
    const r2 = await authed(request(app()).get("/internal/gitea/repo-exists").query({ org: "acme", repo: "a/b" }));
    expect(r2.status).toBe(400);
    const r3 = await authed(request(app()).post("/internal/gitea/archive-repo")).send({ org: "../etc", repo: "workspace" });
    expect(r3.status).toBe(400);
    expect(gitHost().ensureRepo).not.toHaveBeenCalled();
    expect(gitHost().repoExists).not.toHaveBeenCalled();
    expect(gitHost().archiveRepo).not.toHaveBeenCalled();
  });
});

describe("internal gitea-admin route with the provisioning service", () => {
  function service(
    git: LegacyProvisioning["git"],
    gitKey: LegacyProvisioning["gitKey"] = async () => ({ ready: true, value: undefined }),
  ): LegacyProvisioning {
    return {
      chat: vi.fn(async () => {
        throw new Error("chat is not read by the git routes");
      }),
      git: vi.fn(git),
      agentChatToken: vi.fn(async () => {
        throw new Error("the agent chat token is not read by the git routes");
      }),
      gitKey: vi.fn(gitKey),
    };
  }

  function expectNoKeyTouched() {
    expect(gitHost().registerKey).not.toHaveBeenCalled();
    expect(gitHost().registerKeyUnlessHeld).not.toHaveBeenCalled();
    expect(gitHost().releaseKey).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.docs.clear();
    assignUser("acme", "walter");
  });

  it.each([
    ["ensure-org", null],
    ["ensure-workspace-repo", "workspace"],
    ["ensure-system-config-repo", "system-config"],
    ["ensure-project-coach-repo", "project-coaches"],
  ] as const)("%s answers 204 from the service's GitReady without touching the git host", async (route, repository) => {
    const provisioning = service(async () => ({ ready: true, value: undefined }));

    const res = await request(app("walter", "walter", provisioning)).post(`/internal/gitea/${route}`).send({ slug: "acme" });

    expect(res.status).toBe(204);
    expect(provisioning.git).toHaveBeenCalledExactlyOnceWith("uid-acme", repository, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(gitHost().ensureOwner).not.toHaveBeenCalled();
    expect(gitHost().ensureRepo).not.toHaveBeenCalled();
  });

  it("answers 503 with Retry-After while git is not ready", async () => {
    const provisioning = service(async () => ({ ready: false, reason: "GitRepositoryFailed", retryAfterSeconds: 12 }));

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-workspace-repo").send({ slug: "acme" });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("12");
    expect(res.body).toEqual({ error: "provisioning_pending", reason: "GitRepositoryFailed" });
    expect(gitHost().ensureRepo).not.toHaveBeenCalled();
  });

  it("logs the uid, the route and the reason of a not-ready answer", async () => {
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provisioning = service(async () => ({ ready: false, reason: "GitRepositoryFailed", retryAfterSeconds: 12 }));

    await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-workspace-repo").send({ slug: "acme" }).expect(503);

    expect(warned).toHaveBeenCalledWith("legacy provisioning: answering not ready", {
      route: "ensure-workspace-repo", uid: "uid-acme", reason: "GitRepositoryFailed", retryAfterSeconds: 12,
    });
  });

  it("still refuses a user assigned to another gateway before asking the service", async () => {
    const provisioning = service(async () => ({ ready: true, value: undefined }));

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-org").send({ slug: "other" });

    expect(res.status).toBe(403);
    expect(provisioning.git).not.toHaveBeenCalled();
  });

  it("answers 503 and logs the slug when no user carries it", async () => {
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(platformStateStore.users.records, "listByGateway").mockResolvedValueOnce([
      { uid: "uid-ghost", slug: "ghost" } as Awaited<ReturnType<typeof platformStateStore.users.records.listByGateway>>[number],
    ]);
    const provisioning = service(async () => ({ ready: true, value: undefined }));

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-org").send({ slug: "ghost" });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).toEqual({ error: "provisioning_pending", reason: "NotProvisioned" });
    expect(provisioning.git).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("no user"), expect.objectContaining({ slug: "ghost" }));
  });

  it("keeps the project repository route on the git host", async () => {
    const provisioning = service(async () => ({ ready: true, value: undefined }));

    expect((await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-project-repo").send({ slug: "acme", projectName: "mygame" })).status).toBe(204);

    expect(gitHost().ensureRepo).toHaveBeenCalledExactlyOnceWith("acme", { kind: "project", projectSlug: "mygame" });
    expect(provisioning.git).not.toHaveBeenCalled();
  });

  it("ensure-user puts the serving gateway's key through the service and answers 204 once it is registered", async () => {
    const provisioning = service(async () => ({ ready: true, value: undefined }));

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-user").send({ slug: "acme", pubKey: "ssh-ed25519 AAA lin\n" });

    expect(res.status).toBe(204);
    expect(provisioning.gitKey).toHaveBeenCalledExactlyOnceWith("uid-acme", "walter", "ssh-ed25519 AAA lin", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expectNoKeyTouched();
    expect(gitHost().ensureOwner).not.toHaveBeenCalled();
  });

  it("ensure-user answers 503 with the service's reason while the key is not registered", async () => {
    const provisioning = service(async () => ({ ready: true, value: undefined }), async () => ({ ready: false, reason: "GitKeyFailed", retryAfterSeconds: 5 }));

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-user").send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).toEqual({ error: "provisioning_pending", reason: "GitKeyFailed" });
    expectNoKeyTouched();
  });

  it("ensure-user leaves a user another gateway serves alone on a standby gateway, and logs it", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    assignUser("acme", "shared-1");
    mocks.docs.set("gateways/walter", isolatedGateway());
    const provisioning = service(async () => ({ ready: true, value: undefined }));

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-user").send({ slug: "acme", pubKey: "ssh-ed25519 AAA" });

    expect(res.status).toBe(204);
    expect(provisioning.gitKey).not.toHaveBeenCalled();
    expectNoKeyTouched();
    expect(info).toHaveBeenCalledWith("internal/gitea ensure-user: a standby gateway registers no key for a user another gateway serves", { gatewayId: "walter", uid: "uid-acme" });
  });

  it("re-mounts an existing user whose key carries a legacy pod title, ending registered with one key under the gateway", async () => {
    const key = "ssh-ed25519 AAAA lin";
    const hostKeys = [{ publicKey: key, holder: WALTER_KEY_OWNER }];
    let row: GitKey | null = null;
    const worker = () => {
      if (row === null || row.status.observedGeneration >= row.generation) return;
      const kept = hostKeys.filter((held) => held.publicKey !== row!.spec.publicKey);
      hostKeys.splice(0, hostKeys.length, ...kept, { publicKey: row.spec.publicKey, holder: row.gatewayId });
      row = { ...row, status: { observedGeneration: row.generation, conditions: [{
        type: "Registered", status: "True", reason: "Converged", message: "", lastTransitionTime: "2026-11-15T18:00:00Z", observedGeneration: row.generation,
      }] } };
    };
    const client: LegacyProvisioningClient = {
      getProvisioning: vi.fn(async () => null),
      getCredential: vi.fn(async () => null),
      putGitKey: vi.fn(async (uid, gatewayId, spec) => {
        row ??= { uid, gatewayId, generation: 1, resourceVersion: "1", deletionRequestedAt: null, spec, status: { observedGeneration: 0, conditions: [], nextAttemptAt: null } };
        return { outcome: "unchanged" as const, key: row };
      }),
    };
    const provisioning = createLegacyProvisioning({ client, sleep: async () => worker() });

    const res = await request(app("walter", "walter", provisioning)).post("/internal/gitea/ensure-user").send({ slug: "acme", pubKey: key });

    expect(res.status).toBe(204);
    expect(hostKeys).toEqual([{ publicKey: key, holder: "walter" }]);
    expect(row).toMatchObject({ status: { observedGeneration: 1, conditions: [{ type: "Registered", status: "True" }] } });
    expectNoKeyTouched();
  });
});
