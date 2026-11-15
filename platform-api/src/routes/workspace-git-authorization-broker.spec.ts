import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { createWorkspaceGitAuthorizationBrokerRoutes } from "./workspace-git-authorization-broker.js";

const resolveTarget = vi.fn();

function assignedStore(assigned: Array<{ uid: string; gatewayId: string; slug: string }>): PlatformStateStore {
  return createDocumentFixtureStore(Object.fromEntries(assigned.map((user) => [
    `users/${user.uid}`,
    { provisioning: { openclaw: { gatewayId: user.gatewayId, slug: user.slug } } },
  ])));
}

interface Caller {
  uid?: string;
  user?: Record<string, unknown>;
  workspaceSlug?: string | null;
}

function app(options: { bound?: boolean; caller?: Caller | ((req: express.Request) => Caller); store?: PlatformStateStore } = {}) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    if (options.bound !== false) {
      req.boundTenant = {
        kind: "gateway",
        gatewayId: "walter",
        podName: "octogee-gateway-walter-r2-5bc5949d46-p946t",
        actor: "gateway",
        subject: "system:serviceaccount:octogee:octogee-gw-walter",
        serviceAccountName: "octogee-gw-walter",
      } as Express.Request["boundTenant"];
    }
    const caller = typeof options.caller === "function" ? options.caller(req) : options.caller ?? { uid: "uid-member", user: { displayName: "Mem Ber", email: "member@example.com" }, workspaceSlug: "member" };
    req.uid = caller.uid;
    req.user = caller.user;
    req.workspaceSlug = caller.workspaceSlug;
    next();
  });
  instance.use("/internal/workspace-git", createWorkspaceGitAuthorizationBrokerRoutes({
    store: options.store ?? assignedStore([{ uid: "uid-alice", gatewayId: "walter", slug: "alice" }]),
    resolveTarget,
  }));
  return instance;
}

const body = {
  gatewayId: "walter",
  slug: "alice",
  projectSlug: "orbit",
  access: "write",
  resolveGithubToken: true,
};

beforeEach(() => {
  resolveTarget.mockReset().mockResolvedValue({
    ok: true,
    target: {
      slug: "alice",
      projectSlug: "orbit",
      provider: "github",
      org: "octogee-ai",
      repoName: "orbit",
      gcsPrefix: "customers/alice/projects/orbit",
      githubToken: "gh-member-token",
      brokered: true,
    },
  });
});

describe("POST /internal/workspace-git/authorize", () => {
  it("keeps authorization budgets separate for callers sharing a gateway", async () => {
    const client = request(app({ caller: req => ({ uid: req.get("x-fixture-uid") ?? "uid-a" }) }));
    for (let count = 0; count < 360; count++) await client.post("/internal/workspace-git/authorize").send(body).expect(200);
    await client.post("/internal/workspace-git/authorize").send(body).expect(429);
    expect(resolveTarget).toHaveBeenCalledTimes(360);
    await client.post("/internal/workspace-git/authorize").set("x-fixture-uid", "uid-b").send(body).expect(200);
  });

  it("refuses a request that is not bound to the gateway it names", async () => {
    expect((await request(app({ bound: false })).post("/internal/workspace-git/authorize").send(body)).status).toBe(403);
    expect((await request(app()).post("/internal/workspace-git/authorize").send({ ...body, gatewayId: "other" })).status).toBe(403);
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("requires an authenticated caller", async () => {
    const res = await request(app({ caller: { uid: undefined } })).post("/internal/workspace-git/authorize").send(body);
    expect(res.status).toBe(401);
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("rejects malformed targets and lanes before touching Firestore", async () => {
    for (const bad of [
      { ...body, slug: "../alice" },
      { ...body, slug: 42 },
      { ...body, projectSlug: "Bad/Slug" },
      { ...body, access: "admin" },
      { ...body, resolveGithubToken: "yes" },
    ]) {
      const res = await request(app()).post("/internal/workspace-git/authorize").send(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("answers 404 when the workspace is not assigned to the bound gateway", async () => {
    const res = await request(app({ store: assignedStore([{ uid: "uid-alice", gatewayId: "other", slug: "alice" }]) }))
      .post("/internal/workspace-git/authorize")
      .send(body);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it("resolves the target as the authenticated caller and returns the git grant", async () => {
    const res = await request(app()).post("/internal/workspace-git/authorize").send(body);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(resolveTarget).toHaveBeenCalledWith(
      { slug: "alice", projectSlug: "orbit", callerUid: "uid-member", callerWorkspaceSlug: "member" },
      { access: "write", resolveGithubToken: true },
    );
    expect(res.body).toEqual({
      gatewayId: "walter",
      uid: "uid-member",
      slug: "alice",
      projectSlug: "orbit",
      githubToken: "gh-member-token",
      commitAuthor: { name: "Mem Ber", email: "member@example.com" },
    });
  });

  it("grants a workspace-level tree to its owner with a slug-derived author when the profile is bare", async () => {
    resolveTarget.mockResolvedValueOnce({
      ok: true,
      target: {
        slug: "alice",
        projectSlug: null,
        provider: "gitea",
        org: "ws-alice",
        repoName: "alice-workspace",
        gcsPrefix: "customers/alice",
        sudoUser: "ws-alice",
        brokered: false,
        canvasFile: "README.md",
      },
    });
    const res = await request(app({ caller: { uid: "uid-alice", user: {}, workspaceSlug: "alice" } }))
      .post("/internal/workspace-git/authorize")
      .send({ ...body, projectSlug: null, access: "read", resolveGithubToken: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gatewayId: "walter",
      uid: "uid-alice",
      slug: "alice",
      projectSlug: null,
      githubToken: null,
      commitAuthor: { name: "alice", email: "alice@users.invalid" },
    });
  });

  it("passes target refusals through with their status, error, and reason", async () => {
    resolveTarget.mockResolvedValueOnce({ ok: false, status: 409, error: "Project is archived", reason: "project_archived" });
    const archived = await request(app()).post("/internal/workspace-git/authorize").send(body);
    expect(archived.status).toBe(409);
    expect(archived.body).toEqual({ error: "Project is archived", reason: "project_archived" });

    resolveTarget.mockResolvedValueOnce({ ok: false, status: 403, error: "Forbidden" });
    const forbidden = await request(app()).post("/internal/workspace-git/authorize").send(body);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: "Forbidden" });
  });
});
