import { describe, expect, it, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type { UserCleanupContext } from "../handlers/deprovision-user.js";
import { createSuspendUserHandler, type UserSuspensionDeps } from "../handlers/suspend-user.js";
import type { ProductUserSuspension } from "../lib/user-ops/user-lifecycle-product.js";

const CLEANUP: UserCleanupContext = {
  uid: "uid-ada", slug: "ada", email: "ada@users.invalid", giteaOrg: "ada", repoNames: [], projectSlugs: [],
  workspaceTeamId: null, mmUserId: "mm-ada", mmCoachUserId: null, adminChannelId: null, currentGatewayId: "shared-a",
  credentialSecretNames: [], projectAgentMmUserIds: [], projectAgentCredentialDocPaths: [], chatArtifactIds: [], agentImportIds: [],
};

const OPERATION = { id: "op-1", kind: "suspend-user", input: { uid: "uid-ada", deletionId: "del-1" } } as unknown as Operation;

function suspensionDeps(product?: ProductUserSuspension, cleanup: UserCleanupContext = CLEANUP): UserSuspensionDeps {
  const done = vi.fn(async () => undefined);
  return {
    loadDeletionJob: async () => ({ uid: "uid-ada", slug: "ada", currentGatewayId: "shared-a", productContext: {}, cleanupContext: cleanup }),
    loadCleanupContext: async () => CLEANUP,
    persistCleanupContext: done,
    assertRestoreNotInProgress: done,
    blockChatSignIn: vi.fn(async () => undefined),
    blockGitSignIn: vi.fn(async () => undefined),
    cancelUserMigrations: vi.fn(async () => false),
    deactivateUserVisibility: done,
    unmountFromGateway: vi.fn(async () => "unmounted" as const),
    releasePlacement: done,
    revokeConnectorGrants: done,
    revokeModelBrokerAccess: done,
    deleteCredentialSecrets: done,
    retireProjectAgentMattermostUsers: done,
    deleteProjectAgentCredentialDocs: done,
    ensureOwnedGatewaysRetired: vi.fn(async () => "not-owned" as const),
    markSuspended: vi.fn(async () => undefined),
    ...(product ? { product } : {}),
    now: () => 1,
  };
}

async function suspend(deps: UserSuspensionDeps) {
  const steps: OperationStep[] = [];
  const result = await createSuspendUserHandler(deps)(OPERATION, {
    reportStep: async (step: OperationStep) => { steps.push(step); },
  } as never);
  return { result, steps: steps.map((step) => `${step.name}:${step.status}`) };
}

describe("suspending a user", () => {
  it("suspends a platform user with no product sign-in or product data", async () => {
    const deps = suspensionDeps();

    const { result, steps } = await suspend(deps);

    expect(result).toEqual({ steps: [], success: true });
    expect(steps).toEqual([
      "capture-cleanup-context:skipped",
      "suspend-auth:skipped",
      "suspend-chat-sign-in:done",
      "suspend-git-sign-in:done",
      "cancel-customer-migrations:done",
      "deactivate-customer-visibility:done",
      "unmount-gateway:done",
      "release-placement:done",
      "retire-owned-gateways:done",
      "revoke-connector-grants:done",
      "revoke-model-broker:done",
      "delete-credential-secrets:done",
      "retire-project-agent-users:done",
      "delete-project-agent-credentials:done",
      "mark-suspended:done",
    ]);
    expect(deps.markSuspended).toHaveBeenCalledWith("del-1");
    expect(deps.blockChatSignIn).toHaveBeenCalledWith("mm-ada");
    expect(deps.blockGitSignIn).toHaveBeenCalledWith("ada");
  });

  it("skips the sign-in steps for a user with no chat account or workspace", async () => {
    const deps = suspensionDeps(undefined, { ...CLEANUP, mmUserId: null, slug: "" });

    const { result, steps } = await suspend(deps);

    expect(result).toEqual({ steps: [], success: true });
    expect(steps).toEqual(expect.arrayContaining(["suspend-chat-sign-in:skipped", "suspend-git-sign-in:skipped"]));
    expect(deps.blockChatSignIn).not.toHaveBeenCalled();
    expect(deps.blockGitSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["suspend-chat-sign-in", "blockChatSignIn", "mm deactivate user mm-ada failed: 503 unavailable"],
    ["suspend-git-sign-in", "blockGitSignIn", "gitea-admin block-sign-in failed: 500 database is locked"],
  ] as const)("fails %s for a cleanup retry, runs every later step, and completes once the retry succeeds", async (step, dependency, message) => {
    const deps = suspensionDeps();
    vi.mocked(deps[dependency]).mockRejectedValueOnce(new Error(message));

    const first = await suspend(deps);

    expect(first.result).toEqual({
      steps: [],
      success: false,
      error: `${step}: ${message}`,
      output: { deletionCleanupRetry: { deletionId: "del-1" } },
    });
    expect(first.steps).toEqual(expect.arrayContaining([`${step}:failed`, "delete-project-agent-credentials:done"]));
    expect(deps.markSuspended).not.toHaveBeenCalled();

    const retry = await suspend(deps);

    expect(retry.result).toEqual({ steps: [], success: true });
    expect(retry.steps).toEqual(expect.arrayContaining([`${step}:done`, "mark-suspended:done"]));
    expect(deps[dependency]).toHaveBeenCalledTimes(2);
  });

  it("runs the product's sign-in suspension and its steps at their points in the sequence", async () => {
    const product: ProductUserSuspension = {
      suspendSignIn: vi.fn(async () => undefined),
      afterVisibilityDeactivation: async (_job, steps) => steps.run("deactivate-social", async () => undefined),
      afterGatewayRetirement: async (_job, steps) => steps.skip("product-after-retirement"),
      afterModelBrokerRevocation: async (_job, steps) => steps.run("product-after-broker", async () => undefined),
    };

    const { result, steps } = await suspend(suspensionDeps(product));

    expect(result).toMatchObject({ success: true });
    expect(product.suspendSignIn).toHaveBeenCalledWith("uid-ada");
    expect(steps).toEqual(expect.arrayContaining(["suspend-auth:done"]));
    expect(steps.indexOf("deactivate-social:done")).toBe(steps.indexOf("deactivate-customer-visibility:done") + 1);
    expect(steps.indexOf("product-after-retirement:skipped")).toBe(steps.indexOf("retire-owned-gateways:done") + 1);
    expect(steps.indexOf("product-after-broker:done")).toBe(steps.indexOf("revoke-model-broker:done") + 1);
  });

  it("fails the operation for a cleanup retry when a product step fails, after running every later step", async () => {
    const product: ProductUserSuspension = {
      suspendSignIn: vi.fn(async () => { throw new Error("Could not load the default credentials."); }),
      afterVisibilityDeactivation: async () => undefined,
      afterGatewayRetirement: async () => undefined,
      afterModelBrokerRevocation: async () => undefined,
    };
    const deps = suspensionDeps(product);

    const { result, steps } = await suspend(deps);

    expect(result).toEqual({
      steps: [],
      success: false,
      error: "suspend-auth: Could not load the default credentials.",
      output: { deletionCleanupRetry: { deletionId: "del-1" } },
    });
    expect(steps).toEqual(expect.arrayContaining(["suspend-auth:failed", "delete-project-agent-credentials:done"]));
    expect(deps.markSuspended).not.toHaveBeenCalled();
  });
});
