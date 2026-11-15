import { describe, it, expect, vi } from "vitest";
import { createMattermostChannelHost } from "@octogee/core/channel-host";
import { nukeUserCloudSide, type NukeCloudCtx, type NukeCloudDeps } from "../lib/user-ops/nuke-cloud";

function mkCtx(overrides: Partial<NukeCloudCtx> = {}): NukeCloudCtx {
  return {
    uid: "uid-alice",
    currentOperationId: "erase-1",
    slug: "alice",
    email: "alice@example.com",
    repoNames: ["workspace", "blog"],
    projectSlugs: ["blog"],
    workspaceTeamId: "team-1",
    mmUserId: "mm-u-1",
    mmCoachUserId: "mm-coach-1",
    adminChannelId: "mm-c-admin",
    credentialSecretNames: [],
    projectAgentMmUserIds: ["mm-project-1", "mm-project-2"],
    projectAgentCredentialDocPaths: [
      "users/uid-alice/secrets/projectAgentMattermost-blog",
    ],
    chatArtifactIds: ["a".repeat(64)],
    agentImportIds: ["import-1"],
    ...overrides,
  };
}

function mkDeps(overrides: Partial<NukeCloudDeps> = {}): NukeCloudDeps {
  return {
    git: { eraseOwner: vi.fn(async () => undefined) },
    channels: { erase: vi.fn(async () => undefined) },
    eraseUserRecords: vi.fn(async () => undefined),
    deleteUserStorage: vi.fn(async () => undefined),
    deleteHostingSites: vi.fn(async () => ({ deleted: 0 })),
    deleteCredentialSecrets: vi.fn(async () => undefined),
    deleteSignIn: vi.fn(async () => undefined),
    deleteVm: vi.fn(async () => true),
    deleteVmHome: vi.fn(async () => ({ deleted: 2 })),
    log: vi.fn(),
    ...overrides,
  };
}

describe("nukeUserCloudSide — happy path", () => {
  it("runs all nine erasure steps and reports each as ok", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.map((r) => `${r.key}:${r.ok}`)).toEqual([
      "gitea:true",
      "mattermost:true",
      "storage:true",
      "hosting:true",
      "credentials:true",
      "computer:true",
      "computer-home:true",
      "records:true",
      "sign-in:true",
    ]);
    expect(deps.deleteVm).toHaveBeenCalledWith("uid-alice");
    expect(results.find((r) => r.key === "hosting")).toMatchObject({ ok: true });
  });

  it("sweeps the home checkpoints only after the VM is gone and journals the object count", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.deleteVmHome).toHaveBeenCalledWith("alice");
    expect(vi.mocked(deps.deleteVm!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.deleteVmHome!).mock.invocationCallOrder[0],
    );
    expect(results.find((r) => r.key === "computer-home")).toEqual({
      key: "computer-home",
      ok: true,
      detail: "2 objects",
    });
  });

  it("still sweeps the home checkpoints on a pod-only fleet, and skips only without a slug", async () => {
    const podOnly = mkDeps({ deleteVm: undefined });
    await nukeUserCloudSide(mkCtx(), podOnly);
    expect(podOnly.deleteVmHome).toHaveBeenCalledWith("alice");

    const unprovisioned = mkDeps();
    const results = await nukeUserCloudSide(mkCtx({ slug: "" }), unprovisioned);
    expect(unprovisioned.deleteVmHome).not.toHaveBeenCalled();
    expect(results.find((r) => r.key === "computer-home")).toEqual({ key: "computer-home", ok: true, skipped: true });
  });

  it("erases records and skips the home sweep and sign-in deletion when no product supplies them", async () => {
    const deps = mkDeps({ deleteVmHome: undefined, deleteSignIn: undefined, deleteVm: undefined });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.map((r) => `${r.key}:${r.ok}:${r.skipped === true}`)).toEqual([
      "gitea:true:false",
      "mattermost:true:false",
      "storage:true:false",
      "hosting:true:false",
      "credentials:true:false",
      "computer:true:true",
      "computer-home:true:true",
      "records:true:false",
      "sign-in:true:true",
    ]);
    expect(deps.eraseUserRecords).toHaveBeenCalled();
  });

  it("fails the vm-home step loudly and blocks sign-in deletion when the sweep fails", async () => {
    const deps = mkDeps({ deleteVmHome: vi.fn(async () => { throw new Error("storage 403"); }) });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.find((r) => r.key === "computer-home")).toEqual({ key: "computer-home", ok: false, error: "storage 403" });
    expect(results.find((r) => r.key === "sign-in")).toEqual({ key: "sign-in", ok: true, skipped: true });
    expect(deps.eraseUserRecords).not.toHaveBeenCalled();
  });

  it("skips the VM step on a pod-only fleet and blocks sign-in deletion when the VM survives", async () => {
    const podOnly = await nukeUserCloudSide(mkCtx(), mkDeps({ deleteVm: undefined }));
    expect(podOnly.find((r) => r.key === "computer")).toEqual({ key: "computer", ok: true, skipped: true });

    const stuck = await nukeUserCloudSide(mkCtx(), mkDeps({ deleteVm: vi.fn(async () => { throw new Error("compute 403"); }) }));
    expect(stuck.find((r) => r.key === "computer")).toMatchObject({ ok: false, error: "compute 403" });
    expect(stuck.find((r) => r.key === "sign-in")).toEqual({ key: "sign-in", ok: true, skipped: true });
  });

  it("Gitea step erases every repo, the owner, and the user", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.git.eraseOwner).toHaveBeenCalledWith("alice", ["workspace", "blog", "project_coaches"]);
  });

  it("direct and group memberships do not block permanent Mattermost user and team erasure", async () => {
    const deletes: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      if (init.method !== "DELETE") return new Response(JSON.stringify([
        { id: "public", type: "O", team_id: "team-1" },
        { id: "direct", type: "D", team_id: "" },
        { id: "group", type: "G", team_id: "" },
        { id: "private", type: "P", team_id: "team-1" },
      ]));
      deletes.push(new URL(url).pathname + new URL(url).search);
      return new Response(JSON.stringify({ id: "api.channel.delete_channel.type.invalid" }), {
        status: path.endsWith("/direct") || path.endsWith("/group") ? 400 : 200,
      });
    }) as unknown as typeof fetch;
    const channels = createMattermostChannelHost({ baseUrl: "https://mm.test", adminToken: "admin", fetch: fetchImpl });
    const deps = mkDeps({ channels });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.find(result => result.key === "mattermost")).toMatchObject({ ok: true });
    expect(deletes).toEqual([
      "/api/v4/channels/public", "/api/v4/channels/private",
      "/api/v4/users/mm-u-1?permanent=true", "/api/v4/channels/mm-c-admin",
      "/api/v4/users/mm-coach-1?permanent=true",
      "/api/v4/users/mm-project-1?permanent=true", "/api/v4/users/mm-project-2?permanent=true",
      "/api/v4/teams/team-1?permanent=true",
    ]);
    expect(deps.eraseUserRecords).toHaveBeenCalled();
    expect(deps.deleteSignIn).toHaveBeenCalled();
  });

  it("MM step erases the owner's channels and user, plus admin channel + defaultAgent + project agents + team", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.channels.erase).toHaveBeenCalledWith({
      teamId: "team-1",
      ownerUserId: "mm-u-1",
      channelIds: ["mm-c-admin"],
      userIds: ["mm-coach-1", "mm-project-1", "mm-project-2"],
    });
  });

  it("MM step gracefully handles missing IDs (raw signup with no MM bootstrap)", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(
      mkCtx({
        workspaceTeamId: null,
        mmUserId: null,
        mmCoachUserId: null,
        adminChannelId: null,
        projectAgentMmUserIds: [],
      }),
      deps,
    );
    expect(deps.channels.erase).toHaveBeenCalledWith({
      teamId: null,
      ownerUserId: null,
      channelIds: [],
      userIds: [],
    });
  });

  it("permanently deletes a known Mattermost user even when the workspace team is already gone", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(
      mkCtx({ workspaceTeamId: null, mmUserId: "mm-u-orphan" }),
      deps,
    );
    expect(deps.channels.erase).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: null, ownerUserId: "mm-u-orphan" }),
    );
  });
});

describe("nukeUserCloudSide — partial failure", () => {
  it("continues subsequent steps when one fails; reports per-step error", async () => {
    const deps = mkDeps({
      git: {
        eraseOwner: vi.fn(async () => {
          throw new Error("gitea down");
        }),
      },
    });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    const gitea = results.find((r) => r.key === "gitea");
    expect(gitea?.ok).toBe(false);
    expect(gitea?.error).toMatch(/gitea down/);
    expect(deps.eraseUserRecords).toHaveBeenCalled();
    expect(deps.deleteSignIn).not.toHaveBeenCalled();
    expect(results.find((r) => r.key === "sign-in")).toMatchObject({
      ok: true,
      skipped: true,
    });
  });

  it("a sign-in deletion error doesn't block the orchestrator from completing", async () => {
    const deps = mkDeps({
      deleteSignIn: vi.fn(async () => {
        throw new Error("auth/unknown-error");
      }),
    });
    const results = await nukeUserCloudSide(mkCtx(), deps);
    expect(results.find((r) => r.key === "sign-in")?.ok).toBe(false);
    expect(results).toHaveLength(9);
  });
});

describe("nukeUserCloudSide — skip flags", () => {
  it("skipAuth marks the sign-in step skipped without deleting the sign-in", async () => {
    const deps = mkDeps();
    const results = await nukeUserCloudSide(mkCtx({ skipAuth: true }), deps);
    expect(results.find((r) => r.key === "sign-in")).toMatchObject({ ok: true, skipped: true });
    expect(deps.deleteSignIn).not.toHaveBeenCalled();
  });
});

describe("nukeUserCloudSide — hosting step (PR #3)", () => {
  it("calls deleteHostingSites with ctx.slug + ctx.projectSlugs (no regex extraction)", async () => {
    const deleteHostingSites = vi.fn(async () => ({ deleted: 2 }));
    const deps = mkDeps({ deleteHostingSites });
    await nukeUserCloudSide(
      mkCtx({ projectSlugs: ["blog", "shop"] }),
      deps,
    );
    expect(deleteHostingSites).toHaveBeenCalledTimes(1);
    expect(deleteHostingSites).toHaveBeenCalledWith("alice", ["blog", "shop"]);
  });

  it("hosting step is reported as ok when deleteHostingSites resolves", async () => {
    const deleteHostingSites = vi.fn(async () => ({ deleted: 0 }));
    const deps = mkDeps({ deleteHostingSites });
    const results = await nukeUserCloudSide(mkCtx({ projectSlugs: [] }), deps);
    expect(results.find((r) => r.key === "hosting")).toMatchObject({ ok: true });
  });

  it("hosting step is reported as failed when deleteHostingSites throws", async () => {
    const deleteHostingSites = vi.fn(async () => {
      throw new Error("hosting boom");
    });
    const deps = mkDeps({ deleteHostingSites });
    const results = await nukeUserCloudSide(
      mkCtx({ projectSlugs: ["one"] }),
      deps,
    );
    expect(results.find((r) => r.key === "hosting")).toMatchObject({
      ok: false,
      error: expect.stringContaining("hosting boom"),
    });
    expect(results.find((r) => r.key === "records")).toMatchObject({
      ok: true,
      skipped: true,
    });
    expect(deps.eraseUserRecords).not.toHaveBeenCalled();
  });

  it("does NOT extract projectSlugs from repoNames anymore (regression: the old slice produced 'proj-<slug>' instead of '<slug>')", async () => {
    const deleteHostingSites = vi.fn<NonNullable<NukeCloudDeps["deleteHostingSites"]>>(async () => ({ deleted: 1 }));
    const deps = mkDeps({ deleteHostingSites });

await nukeUserCloudSide(
      mkCtx({
        repoNames: ["workspace", "blog"],
        projectSlugs: ["blog"],
      }),
      deps,
    );
    expect(deleteHostingSites).toHaveBeenCalledWith("alice", ["blog"]);
    const args = deleteHostingSites.mock.calls[0]![1];
    expect(args).not.toContain("proj-blog");
  });
});

describe("nukeUserCloudSide — records step", () => {
  it("passes the whole user scope so the workspace and agent records get erased, not just the user subtree", async () => {
    const deps = mkDeps();
    await nukeUserCloudSide(mkCtx(), deps);
    expect(deps.eraseUserRecords).toHaveBeenCalledWith(expect.objectContaining({
      uid: "uid-alice",
      slug: "alice",
      email: "alice@example.com",
      currentOperationId: "erase-1",
    }));
  });

  it("deletes all user storage and credential secrets before the records", async () => {
    const order: string[] = [];
    const deps = mkDeps({
      deleteUserStorage: vi.fn(async () => { order.push("storage"); }),
      deleteCredentialSecrets: vi.fn(async () => { order.push("credentials"); }),
      eraseUserRecords: vi.fn(async () => { order.push("records"); }),
    });
    await nukeUserCloudSide(mkCtx({ credentialSecretNames: ["byosub-1"] }), deps);
    expect(deps.deleteUserStorage).toHaveBeenCalledWith(expect.objectContaining({
      uid: "uid-alice",
      slug: "alice",
      chatArtifactIds: ["a".repeat(64)],
      agentImportIds: ["import-1"],
    }));
    expect(deps.deleteCredentialSecrets).toHaveBeenCalledWith(["byosub-1"]);
    expect(order).toEqual(["storage", "credentials", "records"]);
  });
});
