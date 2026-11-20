import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceGitAuthorizationOutcome } from "@octogee/core/internal-brokers/workspace-git-authorization-broker";

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  gitStatus: vi.fn(),
  gitCommit: vi.fn(),
  gitPush: vi.fn(),
  resolveUserDir: vi.fn(),
  resolveProjectDir: vi.fn(),
  runWorkspaceGitMutation: vi.fn(),
}));

vi.mock("@octogee/core/workspace/workspace-git", () => ({
  gitBranches: vi.fn(),
  gitCheckout: vi.fn(),
  gitCommit: (...args: unknown[]) => h.gitCommit(...args),
  gitCommitDiff: vi.fn(),
  gitDiff: vi.fn(),
  gitLog: vi.fn(),
  gitPush: (...args: unknown[]) => h.gitPush(...args),
  gitStatus: (...args: unknown[]) => h.gitStatus(...args),
  resolveUserDir: (...args: unknown[]) => h.resolveUserDir(...args),
  resolveProjectDir: (...args: unknown[]) => h.resolveProjectDir(...args),
  runWorkspaceGitMutation: (...args: unknown[]) => h.runWorkspaceGitMutation(...args),
}));

vi.mock("@octogee/core/http/logging", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWorkspaceGitRouter } = await import("../routes/workspace/git.js");

const BEARER = "Bearer firebase-token";

function grant(overrides: Partial<Extract<WorkspaceGitAuthorizationOutcome, { kind: "authorized" }>["authorization"]> = {}) {
  return {
    kind: "authorized" as const,
    authorization: {
      gatewayId: "walter",
      uid: "uid-member",
      slug: "alice",
      projectSlug: "orbit",
      githubToken: "gh-member-token",
      commitAuthor: { name: "Mem Ber", email: "member@example.com" },
      ...overrides,
    },
  };
}

function app() {
  const instance = express();
  instance.use(express.json());
  const router = createWorkspaceGitRouter({
    authorize: (...args: unknown[]) => h.authorize(...args),
    localGatewayId: () => "walter",
  });
  instance.use("/api/workspace", router);
  instance.use("/api/g/:gatewayId/workspace", router);
  return instance;
}

beforeEach(() => {
  h.authorize.mockReset().mockResolvedValue(grant());
  h.gitStatus.mockReset().mockResolvedValue({ ok: true, entries: [] });
  h.gitCommit.mockReset().mockResolvedValue({ ok: true, result: { sha: "abc123", empty: false } });
  h.gitPush.mockReset().mockResolvedValue({ ok: true });
  h.resolveUserDir.mockReset().mockResolvedValue("/customers/alice");
  h.resolveProjectDir.mockReset().mockResolvedValue("/customers/alice/projects/orbit");
  h.runWorkspaceGitMutation.mockReset().mockImplementation(async (_dir, work) => ({
    ok: true,
    result: await work(),
  }));
});

describe("gateway-local workspace git authorization", () => {
  it("only answers on its own fleet-scoped path and never consults the broker for another gateway", async () => {
    expect((await request(app()).get("/api/workspace/git/status?slug=alice").set("authorization", BEARER)).status).toBe(404);
    expect((await request(app()).get("/api/g/other/workspace/git/status?slug=alice").set("authorization", BEARER)).status).toBe(404);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("answers 401 without a bearer and 400 without a slug before reaching the broker", async () => {
    const unauthenticated = await request(app()).get("/api/g/walter/workspace/git/status?slug=alice");
    expect(unauthenticated.status).toBe(401);
    const missingSlug = await request(app()).get("/api/g/walter/workspace/git/status").set("authorization", BEARER);
    expect(missingSlug.status).toBe(400);
    expect(missingSlug.body).toEqual({ error: "Missing slug" });
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("authorizes reads through the broker with the caller's bearer, the local gateway, and the read lane", async () => {
    const res = await request(app())
      .get("/api/g/walter/workspace/git/status?slug=alice&project=orbit")
      .set("authorization", BEARER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
    expect(h.authorize).toHaveBeenCalledWith({
      gatewayId: "walter",
      authorization: BEARER,
      slug: "alice",
      projectSlug: "orbit",
      lane: { access: "read", resolveGithubToken: false },
    });
    expect(h.gitStatus).toHaveBeenCalledWith("/customers/alice/projects/orbit");
  });

  it("limits mutations by the broker's user identity and leaves read traffic available", async () => {
    const client = request(app());
    const commit = () => client.post("/api/g/walter/workspace/git/commit")
      .set("authorization", BEARER).send({ slug: "alice", project: "orbit", message: "save" });
    for (let count = 0; count < 30; count++) await commit().expect(200);
    await commit().expect(429);
    expect(h.gitCommit).toHaveBeenCalledTimes(30);
    await client.get("/api/g/walter/workspace/git/status?slug=alice&project=orbit").set("authorization", BEARER).expect(200);
    h.authorize.mockResolvedValueOnce(grant({ uid: "uid-second-member" }));
    await commit().expect(200);
  });

  it.each(["status", "diff", "log", "branches"])("answers 503 CUSTOMER_DIR_MISSING for /git/%s when an authorized workspace is not mounted", async (name) => {
    h.authorize.mockResolvedValueOnce(grant({ projectSlug: null, githubToken: null }));
    h.resolveUserDir.mockResolvedValueOnce(null);
    const res = await request(app())
      .get(`/api/g/walter/workspace/git/${name}?slug=alice`)
      .set("authorization", BEARER);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Working tree temporarily unavailable; retry in a few seconds.",
      code: "CUSTOMER_DIR_MISSING",
    });
    expect(h.resolveUserDir).toHaveBeenCalledWith(expect.any(String), "alice");
    expect(h.gitStatus).not.toHaveBeenCalled();
  });

  it("passes broker refusals through with their status and body", async () => {
    h.authorize.mockResolvedValueOnce({ kind: "unauthenticated" });
    expect((await request(app()).get("/api/g/walter/workspace/git/status?slug=alice").set("authorization", BEARER)).status).toBe(401);

    h.authorize.mockResolvedValueOnce({ kind: "denied", status: 403, error: "Forbidden" });
    const forbidden = await request(app()).get("/api/g/walter/workspace/git/status?slug=alice").set("authorization", BEARER);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: "Forbidden" });

    h.authorize.mockResolvedValueOnce({
      kind: "denied", status: 409, error: "Project is archived", reason: "project_archived",
    });
    const archived = await request(app())
      .post("/api/g/walter/workspace/git/commit")
      .set("authorization", BEARER)
      .send({ slug: "alice", project: "orbit", message: "wip" });
    expect(archived.status).toBe(409);
    expect(archived.body).toEqual({ error: "Project is archived", reason: "project_archived" });
    expect(h.gitStatus).not.toHaveBeenCalled();
    expect(h.gitCommit).not.toHaveBeenCalled();
  });

  it("answers 503 with a code when the broker is unreachable", async () => {
    h.authorize.mockRejectedValueOnce(new Error("workspace git authorization broker timed out"));
    const res = await request(app()).get("/api/g/walter/workspace/git/status?slug=alice").set("authorization", BEARER);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Authorization unavailable", code: "AUTH_BROKER_UNAVAILABLE" });
  });

  it("commits under the write lane as the broker-resolved author", async () => {
    const res = await request(app())
      .post("/api/g/walter/workspace/git/commit")
      .set("authorization", BEARER)
      .send({ slug: "alice", project: "orbit", message: "  ship it  " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sha: "abc123", empty: false });
    expect(h.authorize).toHaveBeenCalledWith(expect.objectContaining({
      lane: { access: "write", resolveGithubToken: false },
    }));
    expect(h.gitCommit).toHaveBeenCalledWith("/customers/alice/projects/orbit", {
      message: "ship it",
      author: { name: "Mem Ber", email: "member@example.com" },
    });
  });

  it("refuses to publish a GitHub project even when an older broker returns a GitHub credential", async () => {
    const res = await request(app())
      .post("/api/g/walter/workspace/git/push")
      .set("authorization", BEARER)
      .send({ slug: "alice", project: "orbit", branch: "feature/member" });

    expect(res.status).toBe(409);
    expect(h.gitPush).not.toHaveBeenCalled();
  });

  it("pushes a gitea-backed workspace tree without a github token", async () => {
    h.authorize.mockResolvedValueOnce(grant({ projectSlug: null, githubToken: null }));
    const res = await request(app())
      .post("/api/g/walter/workspace/git/push")
      .set("authorization", BEARER)
      .send({ slug: "alice" });

    expect(res.status).toBe(200);
    expect(h.resolveUserDir).toHaveBeenCalledWith(expect.any(String), "alice");
    expect(h.gitPush).toHaveBeenCalledWith("/customers/alice", { branch: undefined });
  });
});
