import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_GIT_AUTHORIZATION_BROKER_PATH,
  authorizeWorkspaceGit,
} from "./workspace-git-authorization-broker.js";

const dir = mkdtempSync(join(tmpdir(), "workspace-git-authorization-"));
const tokenPath = join(dir, "token");
writeFileSync(tokenPath, "projected-sa-token\n");

function brokerStub(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

const args = {
  gatewayId: "b-alice",
  authorization: "Bearer firebase-token",
  slug: "alice",
  projectSlug: "orbit",
  lane: { access: "write" as const, resolveGithubToken: true },
  baseUrl: "http://octogee-api:3001",
  tokenPath,
};

const granted = {
  gatewayId: "b-alice",
  uid: "uid-member",
  slug: "alice",
  projectSlug: "orbit",
  githubToken: "gh-member-token",
  commitAuthor: { name: "Mem Ber", email: "member@example.com" },
};

describe("authorizeWorkspaceGit", () => {
  it("posts the caller's bearer, the projected token, the target and the lane; returns the grant", async () => {
    const fetchImpl = brokerStub(200, granted);
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl })).resolves.toEqual({
      kind: "authorized",
      authorization: granted,
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://octogee-api:3001${WORKSPACE_GIT_AUTHORIZATION_BROKER_PATH}`);
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer firebase-token");
    expect(headers.get("x-k8s-sa-token")).toBe("projected-sa-token");
    expect(JSON.parse(String(init.body))).toEqual({
      gatewayId: "b-alice",
      slug: "alice",
      projectSlug: "orbit",
      access: "write",
      resolveGithubToken: true,
    });
  });

  it("refuses locally without a bearer or with an invalid gateway id, never calling the broker", async () => {
    const fetchImpl = brokerStub(200, granted);
    await expect(authorizeWorkspaceGit({ ...args, authorization: undefined, fetchImpl }))
      .resolves.toEqual({ kind: "unauthenticated" });
    await expect(authorizeWorkspaceGit({ ...args, gatewayId: "not a gateway", fetchImpl }))
      .resolves.toEqual({ kind: "denied", status: 404, error: "not_found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 to unauthenticated and passes broker refusals through with their status and body", async () => {
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(401, { error: "Unauthenticated" }) }))
      .resolves.toEqual({ kind: "unauthenticated" });
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(403, { error: "Forbidden" }) }))
      .resolves.toEqual({ kind: "denied", status: 403, error: "Forbidden" });
    await expect(authorizeWorkspaceGit({
      ...args,
      fetchImpl: brokerStub(409, { error: "Project is archived", reason: "project_archived" }),
    })).resolves.toEqual({
      kind: "denied", status: 409, error: "Project is archived", reason: "project_archived",
    });
    await expect(authorizeWorkspaceGit({
      ...args,
      fetchImpl: brokerStub(422, { error: "Connect GitHub to access this project", reason: "caller_github_not_connected" }),
    })).resolves.toEqual({
      kind: "denied", status: 422, error: "Connect GitHub to access this project", reason: "caller_github_not_connected",
    });
  });

  it("throws on other statuses and on refusals without an error message", async () => {
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(502, {}) })).rejects.toThrow(/returned 502/);
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(403, {}) })).rejects.toThrow(/malformed/);
  });

  it("refuses a grant that names another gateway, another target, or lacks a commit author", async () => {
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(200, { ...granted, gatewayId: "b-mallory" }) }))
      .rejects.toThrow(/malformed/);
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(200, { ...granted, slug: "mallory" }) }))
      .rejects.toThrow(/malformed/);
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(200, { ...granted, projectSlug: null }) }))
      .rejects.toThrow(/malformed/);
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(200, { ...granted, commitAuthor: { name: "x" } }) }))
      .rejects.toThrow(/malformed/);
    await expect(authorizeWorkspaceGit({ ...args, fetchImpl: brokerStub(200, { ...granted, githubToken: 42 }) }))
      .rejects.toThrow(/malformed/);
  });

  it("accepts a workspace-level grant with no project and no github token", async () => {
    const workspaceGrant = { ...granted, projectSlug: null, githubToken: null };
    await expect(authorizeWorkspaceGit({
      ...args,
      projectSlug: null,
      lane: { access: "read", resolveGithubToken: false },
      fetchImpl: brokerStub(200, workspaceGrant),
    })).resolves.toEqual({ kind: "authorized", authorization: workspaceGrant });
  });
});
