import type { UserDeletionJobStatus } from "@octogee/core/platform-state";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type {
  OperationContext,
  OperationHandler,
  OperationResult,
} from "../operation-router.js";
import type { UserCleanupContext } from "./deprovision-user.js";
import type { NukeCloudStepResult } from "../lib/user-ops/nuke-cloud.js";
import { UserErasureBlockedError } from "../lib/user-ops/agent-store-erasure.js";
import {
  UserErasureRetryLaterError,
  type ErasureStep,
  type ProductContext,
  type ProductUserErasure,
  type UserLifecycleJob,
} from "../lib/user-ops/user-lifecycle-product.js";

export interface ErasureDeletionJob {
  uid: string;
  status: UserDeletionJobStatus;
  eraseAfter: number;
  productContext: ProductContext;
  archiveId: string | null;
  cleanupContext: UserCleanupContext | null;
}

export interface EraseUserDeps {
  loadDeletionJob: (deletionId: string) => Promise<ErasureDeletionJob | null>;
  ensureAnonymousArchive: (deletionId: string) => Promise<string>;
  retainProductVerificationContext: (deletionId: string, archiveId: string) => Promise<void>;
  ensureOwnedGatewayRetired: (
    cleanup: UserCleanupContext,
    deletionId: string,
  ) => Promise<"not-owned" | "retirement-pending" | "retired">;
  findUndrainedArtifactIds: (artifactIds: string[]) => Promise<string[]>;
  eraseAgentStores: (
    cleanup: UserCleanupContext,
    deletionId: string,
    operation: Operation,
    assertActiveClaim: OperationContext["assertActiveClaim"],
  ) => Promise<void>;
  cloudErase: (
    cleanup: UserCleanupContext,
    currentOperationId: string,
  ) => Promise<NukeCloudStepResult[]>;
  verifyErasure: (
    cleanup: UserCleanupContext,
    currentOperationId: string,
  ) => Promise<string[]>;
  finalizeVerifiedErasure: (
    deletionId: string,
    archiveId: string,
    currentOperationId: string,
  ) => Promise<void>;
  product?: ProductUserErasure;
  now: () => number;
}

interface EraseInput {
  uid?: unknown;
  deletionId?: unknown;
}

async function report(
  ctx: OperationContext,
  deps: EraseUserDeps,
  step: OperationStep,
): Promise<void> {
  await ctx.reportStep({ completedAt: deps.now(), ...step });
}

interface EraseUserContext {
  deletionId: string;
  job: ErasureDeletionJob;
  cleanup: UserCleanupContext;
}

interface ProductVerificationContext {
  job: UserLifecycleJob;
  archiveId: string;
}

type EraseUserLoadResult =
  | { kind: "context"; context: EraseUserContext }
  | { kind: "error"; error: OperationResult }
  | { kind: "awaiting-product-verification"; verification: ProductVerificationContext }
  | { kind: "verified"; deletionId: string; archiveId: string };

async function loadEraseUserContext(
  op: Operation,
  deps: EraseUserDeps,
): Promise<EraseUserLoadResult> {
  const input = op.input as EraseInput;
  const uid = typeof input.uid === "string" ? input.uid : null;
  const deletionId = typeof input.deletionId === "string" ? input.deletionId : null;
  if (!uid || !deletionId) {
    return { kind: "error", error: { steps: [], success: false, error: "missing uid or deletionId in op.input" } };
  }
  const job = await deps.loadDeletionJob(deletionId);
  if (!job || job.uid !== uid) {
    return { kind: "error", error: { steps: [], success: false, error: `deletion job not found or mismatched: ${deletionId}` } };
  }
  if (deps.now() < job.eraseAfter) {
    return { kind: "error", error: { steps: [], success: false, error: "erasure started before the retention deadline" } };
  }
  if (job.status === "verified_pending_completion" && job.archiveId) {
    return { kind: "verified", deletionId, archiveId: job.archiveId };
  }
  if (job.status === "product_verification_pending" && job.archiveId) {
    return {
      kind: "awaiting-product-verification",
      verification: { job: { uid, deletionId, productContext: job.productContext }, archiveId: job.archiveId },
    };
  }
  if (!job.cleanupContext || job.status !== "hibernating") {
    return {
      kind: "error",
      error: {
        steps: [],
        success: false,
        error: "user suspension cleanup context pending",
        output: { deletionFencePending: { deletionId } },
      },
    };
  }
  return { kind: "context", context: { deletionId, job, cleanup: job.cleanupContext } };
}

function deletionBlocked(deletionId: string, step: string, error: string): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    output: { deletionBlocked: { deletionId, step } },
  };
}

function cleanupRetry(deletionId: string, error: string): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    output: { deletionCleanupRetry: { deletionId } },
  };
}

function productStepFailure(
  deletionId: string,
  step: string,
  err: unknown,
): OperationResult {
  const error = err instanceof Error ? err.message : String(err);
  if (err instanceof UserErasureBlockedError) return deletionBlocked(deletionId, step, error);
  const retry = cleanupRetry(deletionId, error);
  if (err instanceof UserErasureRetryLaterError && err.retryAfterMs !== null) {
    return { ...retry, retryAfterMs: err.retryAfterMs };
  }
  return retry;
}

function verifiedErasureResult(deletionId: string, archiveId: string): OperationResult {
  return {
    steps: [],
    success: true,
    output: { archiveId, verifiedDeletion: { deletionId, archiveId } },
    scrubInputOnSuccess: true,
  };
}

async function runProductStep(
  step: ErasureStep,
  job: UserLifecycleJob,
  ctx: OperationContext,
  deps: EraseUserDeps,
): Promise<OperationResult | null> {
  try {
    const status = await step.run(job);
    await report(ctx, deps, { name: step.name, status });
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: step.name, status: "failed", error });
    return productStepFailure(job.deletionId, step.name, err);
  }
}

async function confirmProductVerificationAndFinalize(
  { job, archiveId }: ProductVerificationContext,
  op: Operation,
  ctx: OperationContext,
  deps: EraseUserDeps,
): Promise<OperationResult> {
  const verification = deps.product?.verification;
  if (verification) {
    let outcome: Awaited<ReturnType<typeof verification.confirm>>;
    try {
      outcome = await verification.confirm(job);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await report(ctx, deps, { name: verification.name, status: "failed", error });
      return productStepFailure(job.deletionId, verification.name, err);
    }
    if (outcome === "pending") {
      await report(ctx, deps, { name: verification.name, status: "running" });
      return { steps: [], success: false, ...verification.pending(job) };
    }
    await report(ctx, deps, {
      name: verification.name,
      status: outcome === "skipped" ? "skipped" : "done",
    });
  }
  await deps.finalizeVerifiedErasure(job.deletionId, archiveId, op.id);
  await report(ctx, deps, { name: "destroy-identity-mapping", status: "done" });
  return verifiedErasureResult(job.deletionId, archiveId);
}

function cloudStepStatus(result: NukeCloudStepResult): OperationStep["status"] {
  if (result.skipped) return "skipped";
  return result.ok ? "done" : "failed";
}

async function reportCloudErasure(
  results: NukeCloudStepResult[],
  ctx: OperationContext,
  deps: EraseUserDeps,
): Promise<void> {
  for (const result of results) {
    await report(ctx, deps, {
      name: result.key,
      status: cloudStepStatus(result),
      ...(result.error ? { error: result.error } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }
}

async function runEraseUser(
  op: Operation,
  ctx: OperationContext,
  deps: EraseUserDeps,
): Promise<OperationResult> {
  const loaded = await loadEraseUserContext(op, deps);
  if (loaded.kind === "error") return loaded.error;
  if (loaded.kind === "verified") {
    return verifiedErasureResult(loaded.deletionId, loaded.archiveId);
  }
  if (loaded.kind === "awaiting-product-verification") {
    return confirmProductVerificationAndFinalize(loaded.verification, op, ctx, deps);
  }
  return eraseUserData(loaded.context, op, ctx, deps);
}

async function eraseUserData(
  { deletionId, cleanup, job }: EraseUserContext,
  op: Operation,
  ctx: OperationContext,
  deps: EraseUserDeps,
): Promise<OperationResult> {
  const productJob = { uid: job.uid, deletionId, productContext: job.productContext };

  const archiveId = await deps.ensureAnonymousArchive(deletionId);
  await report(ctx, deps, { name: "archive-operational-data", status: "done" });

  for (const step of deps.product?.steps ?? []) {
    const failure = await runProductStep(step, productJob, ctx, deps);
    if (failure) return failure;
  }

  const retirement = await deps.ensureOwnedGatewayRetired(cleanup, deletionId);
  if (retirement === "retirement-pending") {
    await report(ctx, deps, { name: "retire-owned-gateway", status: "running" });
    return {
      steps: [],
      success: false,
      error: "owned gateway retirement pending",
      output: { retirementFencePending: { deletionId } },
    };
  }
  await report(ctx, deps, {
    name: "retire-owned-gateway",
    status: retirement === "not-owned" ? "skipped" : "done",
  });

  const undrainedArtifactIds = await deps.findUndrainedArtifactIds(cleanup.chatArtifactIds);
  if (undrainedArtifactIds.length > 0) {
    await report(ctx, deps, { name: "drain-artifact-workers", status: "running" });
    return {
      steps: [],
      success: false,
      error: `artifact workers still hold leases: ${undrainedArtifactIds.join(", ")}`,
      output: { artifactDrainPending: { deletionId } },
    };
  }
  await report(ctx, deps, {
    name: "drain-artifact-workers",
    status: cleanup.chatArtifactIds.length > 0 ? "done" : "skipped",
  });

  try {
    await deps.eraseAgentStores(cleanup, deletionId, op, ctx.assertActiveClaim);
    await report(ctx, deps, { name: "erase-agent-stores", status: "done" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await report(ctx, deps, { name: "erase-agent-stores", status: "failed", error });
    return err instanceof UserErasureBlockedError
      ? deletionBlocked(deletionId, "erase-agent-stores", error)
      : cleanupRetry(deletionId, error);
  }
  const cloudResults = await deps.cloudErase(cleanup, op.id);
  await reportCloudErasure(cloudResults, ctx, deps);
  const failures = cloudResults.filter((result) => !result.ok && !result.skipped);
  if (failures.length > 0) {
    return cleanupRetry(
      deletionId,
      failures.map((result) => `${result.key}: ${result.error}`).join("; "),
    );
  }

  const remaining = await deps.verifyErasure(cleanup, op.id);
  if (remaining.length > 0) {
    return cleanupRetry(
      deletionId,
      `erasure verification found identifying references: ${remaining.join(", ")}`,
    );
  }
  await report(ctx, deps, { name: "verify-erasure", status: "done" });
  await deps.retainProductVerificationContext(deletionId, archiveId);
  return confirmProductVerificationAndFinalize({ job: productJob, archiveId }, op, ctx, deps);
}

export function createEraseUserHandler(deps: EraseUserDeps): OperationHandler {
  return (op, ctx) => runEraseUser(op, ctx, deps);
}
