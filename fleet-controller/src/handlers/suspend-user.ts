import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type { UserCleanupContext } from "./deprovision-user.js";
import type { UnmountOutcome } from "../lib/user-ops/unmount-gateway.js";
import type {
  ProductContext,
  ProductUserSuspension,
  SuspensionStepRunner,
} from "../lib/user-ops/user-lifecycle-product.js";

export interface UserDeletionJobForSuspension {
  uid: string;
  slug: string | null;
  currentGatewayId: string | null;
  productContext: ProductContext;
  cleanupContext: UserCleanupContext | null;
}

export interface UserSuspensionDeps {
  loadDeletionJob: (
    deletionId: string,
  ) => Promise<UserDeletionJobForSuspension | null>;
  loadCleanupContext: (uid: string) => Promise<UserCleanupContext | null>;
  persistCleanupContext: (
    deletionId: string,
    cleanup: UserCleanupContext,
  ) => Promise<void>;
  assertRestoreNotInProgress: (uid: string) => Promise<void>;
  blockChatSignIn: (mmUserId: string) => Promise<void>;
  blockGitSignIn: (workspaceSlug: string) => Promise<void>;
  cancelUserMigrations: (uid: string, deletionId: string) => Promise<boolean>;
  deactivateUserVisibility: (uid: string) => Promise<void>;
  unmountFromGateway: (
    gatewayId: string,
    slug: string,
  ) => Promise<UnmountOutcome>;
  releasePlacement: (uid: string, capturedGatewayId: string | null) => Promise<void>;
  revokeConnectorGrants: (uid: string) => Promise<void>;
  revokeModelBrokerAccess: (uid: string) => Promise<void>;
  deleteCredentialSecrets: (secretNames: string[]) => Promise<void>;
  retireProjectAgentMattermostUsers: (userIds: string[]) => Promise<void>;
  deleteProjectAgentCredentialDocs: (docPaths: string[]) => Promise<void>;
  ensureOwnedGatewaysRetired: (
    uid: string,
    deletionId: string,
  ) => Promise<"not-owned" | "retirement-pending" | "retired">;
  markSuspended: (deletionId: string) => Promise<void>;
  product?: ProductUserSuspension;
  now: () => number;
}

interface SuspensionInput {
  uid?: unknown;
  deletionId?: unknown;
}

async function report(
  ctx: OperationContext,
  deps: UserSuspensionDeps,
  step: OperationStep,
): Promise<void> {
  await ctx.reportStep({ completedAt: deps.now(), ...step });
}

function readSuspensionInput(input: SuspensionInput): { uid: string; deletionId: string } | null {
  return typeof input.uid === "string" && input.uid.length > 0 &&
    typeof input.deletionId === "string" && input.deletionId.length > 0
    ? { uid: input.uid, deletionId: input.deletionId }
    : null;
}

async function checkRestoreFence(
  deps: UserSuspensionDeps,
  ctx: OperationContext,
  uid: string,
  deletionId: string,
): Promise<OperationResult | null> {
  try {
    await deps.assertRestoreNotInProgress(uid);
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: "restore-fence", status: "failed", error });
    return { steps: [], success: false, error, output: { deletionCleanupRetry: { deletionId } } };
  }
}

function suspendSignIn(steps: SuspensionStepRunner, product: ProductUserSuspension | undefined, uid: string): Promise<void> {
  return product ? steps.run("suspend-auth", () => product.suspendSignIn(uid)) : steps.skip("suspend-auth");
}

async function suspendPlatformSignIn(
  steps: SuspensionStepRunner,
  deps: Pick<UserSuspensionDeps, "blockChatSignIn" | "blockGitSignIn">,
  cleanup: UserCleanupContext,
): Promise<void> {
  const { mmUserId, slug } = cleanup;
  await (mmUserId ? steps.run("suspend-chat-sign-in", () => deps.blockChatSignIn(mmUserId)) : steps.skip("suspend-chat-sign-in"));
  await (slug ? steps.run("suspend-git-sign-in", () => deps.blockGitSignIn(slug)) : steps.skip("suspend-git-sign-in"));
}

function pendingMigrationRetry(deletionId: string, pending: boolean, failures: string[], previousFailures: number): OperationResult | null {
  if (pending) return { steps: [], success: false, error: "user migration is still settling", output: { deletionCleanupRetry: { deletionId } } };
  if (failures.length > previousFailures) return { steps: [], success: false, error: failures.join("; "), output: { deletionCleanupRetry: { deletionId } } };
  return null;
}

export function createSuspendUserHandler(
  deps: UserSuspensionDeps,
): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = readSuspensionInput(op.input);
    if (!input) {
      return { steps: [], success: false, error: "missing uid or deletionId in op.input" };
    }
    const { uid, deletionId } = input;
    const job = await deps.loadDeletionJob(deletionId);
    if (!job || job.uid !== uid) {
      return { steps: [], success: false, error: `deletion job not found or mismatched: ${deletionId}` };
    }
    const restoreFailure = await checkRestoreFence(deps, ctx, uid, deletionId);
    if (restoreFailure) return restoreFailure;
    let cleanup = job.cleanupContext;
    if (!cleanup) {
      const loaded = await deps.loadCleanupContext(uid);
      if (!loaded) {
        return { steps: [], success: false, error: `cleanup context unavailable for ${uid}` };
      }
      cleanup = {
        ...loaded,
        currentGatewayId: job.currentGatewayId ?? loaded.currentGatewayId,
      };
      await deps.persistCleanupContext(deletionId, cleanup);
      await report(ctx, deps, { name: "capture-cleanup-context", status: "done" });
    } else {
      await report(ctx, deps, { name: "capture-cleanup-context", status: "skipped" });
    }

    const failures: string[] = [];
    const run = async (name: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
        await report(ctx, deps, { name, status: "done" });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push(`${name}: ${error}`);
        await report(ctx, deps, { name, status: "failed", error });
      }
    };
    const skip = (name: string) => report(ctx, deps, { name, status: "skipped" });
    const steps: SuspensionStepRunner = { run, skip };
    const productJob = { uid, deletionId, productContext: job.productContext };

    const product = deps.product;
    await suspendSignIn(steps, product, uid);
    await suspendPlatformSignIn(steps, deps, cleanup);
    let migrationPending = false;
    const failuresBeforeCancellation = failures.length;
    await run("cancel-customer-migrations", async () => {
      migrationPending = await deps.cancelUserMigrations(uid, deletionId);
    });
    const migrationRetry = pendingMigrationRetry(deletionId, migrationPending, failures, failuresBeforeCancellation);
    if (migrationRetry) return migrationRetry;
    await run("deactivate-customer-visibility", () =>
      deps.deactivateUserVisibility(uid));
    await product?.afterVisibilityDeactivation(productJob, steps);
    if (cleanup.currentGatewayId && cleanup.slug) {
      await run("unmount-gateway", () =>
        deps.unmountFromGateway(cleanup.currentGatewayId!, cleanup.slug));
    } else {
      await skip("unmount-gateway");
    }
    await run("release-placement", () =>
      deps.releasePlacement(uid, cleanup.currentGatewayId ?? null));
    await run("retire-owned-gateways", async () => {
      const outcome = await deps.ensureOwnedGatewaysRetired(uid, deletionId);
      if (outcome === "retirement-pending") {
        throw new Error("owned gateway retirement is pending");
      }
    });
    await product?.afterGatewayRetirement(productJob, steps);
    await run("revoke-connector-grants", () => deps.revokeConnectorGrants(uid));
    await run("revoke-model-broker", () => deps.revokeModelBrokerAccess(uid));
    await product?.afterModelBrokerRevocation(productJob, steps);
    await run("delete-credential-secrets", () =>
      deps.deleteCredentialSecrets(cleanup.credentialSecretNames));
    await run("retire-project-agent-users", () =>
      deps.retireProjectAgentMattermostUsers(cleanup.projectAgentMmUserIds));
    await run("delete-project-agent-credentials", () =>
      deps.deleteProjectAgentCredentialDocs(cleanup.projectAgentCredentialDocPaths));

    if (failures.length > 0) {
      return {
        steps: [],
        success: false,
        error: failures.join("; "),
        output: { deletionCleanupRetry: { deletionId } },
      };
    }
    await deps.markSuspended(deletionId);
    await report(ctx, deps, { name: "mark-suspended", status: "done" });
    return { steps: [], success: true };
  };
}
