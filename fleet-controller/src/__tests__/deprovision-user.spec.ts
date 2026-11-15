import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import {
  createDeprovisionUserHandler,
  type UserCleanupContext,
  type DeprovisionUserDeps,
} from "../handlers/deprovision-user";
import type { OperationContext } from "../operation-router";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-deprov-1",
    kind: "deprovision-user",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    input: { uid: "uid-alice" },
    steps: [],
    ...overrides,
  };
}

function mkCtx(): OperationContext & { reported: OperationStep[] } {
  const reported: OperationStep[] = [];
  return {
    reportStep: vi.fn(async (step: OperationStep) => {
      reported.push(step);
    }),
    reported,
  };
}

function mkCleanup(overrides: Partial<UserCleanupContext> = {}): UserCleanupContext {
  return {
    uid: "uid-alice",
    slug: "alice",
    email: "alice@example.com",
    giteaOrg: "alice",
    repoNames: ["workspace", "blog"],
    projectSlugs: ["blog"],
    workspaceTeamId: "team-1",
    mmUserId: "mm-u-1",
    mmCoachUserId: "mm-coach-1",
    adminChannelId: "mm-c-admin",
    currentGatewayId: "gw-test",
    credentialSecretNames: [],
    projectAgentMmUserIds: ["mm-project-1"],
    projectAgentCredentialDocPaths: [
      "users/uid-alice/secrets/projectAgentMattermost-blog",
    ],
    chatArtifactIds: [],
    agentImportIds: [],
    ...overrides,
  };
}

function mkDeps(overrides: Partial<DeprovisionUserDeps> = {}): DeprovisionUserDeps {
  return {
    loadCleanupContext: vi.fn(async () => mkCleanup()),
    unmountFromGateway: vi.fn(async () => "unmounted" as const),
    cloudCleanup: {
      git: { eraseOwner: vi.fn(async () => undefined) },
      channels: { erase: vi.fn(async () => undefined) },
      eraseUserRecords: vi.fn(async () => undefined),
      deleteUserStorage: vi.fn(async () => undefined),
      deleteHostingSites: vi.fn(async () => ({ deleted: 0 })),
      deleteCredentialSecrets: vi.fn(async () => undefined),
      deleteSignIn: vi.fn(async () => undefined),
      deleteVmHome: vi.fn(async () => ({ deleted: 1 })),
      log: vi.fn(),
    },
    now: () => 5_000,
    log: vi.fn(),
    ...overrides,
  };
}

describe("createDeprovisionUserHandler — happy path", () => {
  it("returns success=true and reports unmount-gateway + 8 cloud steps", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionUserHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    const stepNames = ctx.reported.map((s) => `${s.name}:${s.status}`);
    expect(stepNames).toEqual([
      "unmount-gateway:running",
      "unmount-gateway:done",
      "gitea:done",
      "mattermost:done",
      "storage:done",
      "hosting:done",
      "credentials:done",
      "computer:skipped",
      "computer-home:done",
      "records:done",
      "sign-in:done",
    ]);
    expect(ctx.reported.find((s) => s.name === "computer-home")).toMatchObject({ detail: "1 object" });
  });

  it("calls unmountFromGateway with gateway + slug from cleanup context", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionUserHandler(deps);
    await handler(mkOp({}), mkCtx());
    expect(deps.unmountFromGateway).toHaveBeenCalledWith("gw-test", "alice");
  });
});

describe("createDeprovisionUserHandler — orphan path (no gateway)", () => {
  it("skips the unmount step, runs cloud cleanup, returns success", async () => {
    const deps = mkDeps({
      loadCleanupContext: vi.fn(async () => mkCleanup({ currentGatewayId: null })),
    });
    const handler = createDeprovisionUserHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    expect(deps.unmountFromGateway).not.toHaveBeenCalled();
    expect(ctx.reported[0]).toMatchObject({ name: "unmount-gateway", status: "skipped" });
    
    expect(deps.cloudCleanup.git.eraseOwner).toHaveBeenCalled();
  });
});

describe("createDeprovisionUserHandler — gateway has no live pod", () => {
  it("reports the unmount step skipped and proceeds with cloud cleanup", async () => {
    const deps = mkDeps({
      unmountFromGateway: vi.fn(async () => "skipped-no-live-pod" as const),
    });
    const handler = createDeprovisionUserHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(true);
    const unmountSteps = ctx.reported.filter((s) => s.name === "unmount-gateway");
    expect(unmountSteps.map((s) => s.status)).toEqual(["running", "skipped"]);
    expect(deps.cloudCleanup.eraseUserRecords).toHaveBeenCalled();
  });
});

describe("createDeprovisionUserHandler — unmount RPC failure", () => {
  it("reports failure for retry after continuing independent cloud cleanup", async () => {
    const deps = mkDeps({
      unmountFromGateway: vi.fn(async () => {
        throw new Error("gateway unreachable");
      }),
    });
    const handler = createDeprovisionUserHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

expect(deps.cloudCleanup.eraseUserRecords).toHaveBeenCalled();
    
    const unmountSteps = ctx.reported.filter((s) => s.name === "unmount-gateway");
    expect(unmountSteps.map((s) => s.status)).toEqual(["running", "failed"]);
    expect(unmountSteps[1].error).toMatch(/gateway unreachable/);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain("unmount-gateway: gateway unreachable");
  });
});

describe("createDeprovisionUserHandler — cloud step failure", () => {
  it("returns success=false with the partial-failure summary when a cloud step fails", async () => {
    const deps = mkDeps({
      cloudCleanup: {
        git: {
          eraseOwner: vi.fn(async () => {
            throw new Error("gitea boom");
          }),
        },
        channels: { erase: vi.fn() },
        eraseUserRecords: vi.fn(),
        deleteUserStorage: vi.fn(),
        deleteCredentialSecrets: vi.fn(),
        deleteSignIn: vi.fn(),
        deleteVmHome: vi.fn(async () => ({ deleted: 0 })),
        log: vi.fn(),
      },
    });
    const handler = createDeprovisionUserHandler(deps);
    const ctx = mkCtx();

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cloud cleanup partial failure/);
    expect(result.error).toMatch(/gitea: gitea boom/);
  });
});

describe("createDeprovisionUserHandler — input validation", () => {
  it("returns failure when uid is missing from op.input", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionUserHandler(deps);
    const result = await handler(mkOp({ input: {} }), mkCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing uid/);
    expect(deps.loadCleanupContext).not.toHaveBeenCalled();
  });

  it("returns failure when user not found", async () => {
    const deps = mkDeps({
      loadCleanupContext: vi.fn(async () => null),
    });
    const handler = createDeprovisionUserHandler(deps);
    const result = await handler(mkOp({}), mkCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/user not found/);
  });

  it("rejects when user has no slug (caller should have used inline lite-delete)", async () => {
    const deps = mkDeps({
      loadCleanupContext: vi.fn(async () => mkCleanup({ slug: "" })),
    });
    const handler = createDeprovisionUserHandler(deps);
    const result = await handler(mkOp({}), mkCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no slug/);
  });
});

describe("createDeprovisionUserHandler — skip flags", () => {
  it("propagates skipAuth from op.input → nukeUserCloudSide → sign-in step skipped", async () => {
    const deps = mkDeps();
    const handler = createDeprovisionUserHandler(deps);
    const ctx = mkCtx();
    await handler(mkOp({ input: { uid: "uid-alice", skipAuth: true } }), ctx);
    expect(deps.cloudCleanup.deleteSignIn).not.toHaveBeenCalled();
    expect(ctx.reported.find((s) => s.name === "sign-in")?.status).toBe("skipped");
  });
});
