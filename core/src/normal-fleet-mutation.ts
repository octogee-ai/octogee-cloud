import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { randomUUID } from "node:crypto";
import type {
  OperationAuditAliasOutcome,
  OperationAuditPartialOutcome,
  OperationAuditReleaseRolloutLinkage,
} from "@octogee/shared/types/glm";
import {
  claimOperationAuditAction,
  finishOperationAudit,
  recordOperationAuditIntent,
  type OperationAuditActionClaim,
  type OperationAuditIntentInput,
} from "./operation-audit.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const logger = createServiceLogger("fleet-mutation");

export class FleetMutationIdempotencyError extends Error {
  constructor(readonly auditId: string, readonly status: "recorded" | "in-progress" | "completed" | "failed") {
    super(`fleet mutation with this Idempotency-Key is already ${status}`);
    this.name = "FleetMutationIdempotencyError";
  }
}

export type NormalFleetMutationResult =
  | {
      outcome: "completed";
      aliasOutcomes?: OperationAuditAliasOutcome[];
      releaseRollout?: OperationAuditReleaseRolloutLinkage;
    }
  | {
      outcome: "partial";
      partialOutcome: OperationAuditPartialOutcome;
      aliasOutcomes?: OperationAuditAliasOutcome[];
      releaseRollout?: OperationAuditReleaseRolloutLinkage;
    }
  | {
      outcome: "failed";
      error: string;
      partialOutcome?: OperationAuditPartialOutcome;
      aliasOutcomes?: OperationAuditAliasOutcome[];
      releaseRollout?: OperationAuditReleaseRolloutLinkage;
    };

export class FleetMutationPartialError extends Error {
  constructor(
    message: string,
    readonly partialOutcome: OperationAuditPartialOutcome,
    readonly aliasOutcomes?: OperationAuditAliasOutcome[],
    readonly releaseRollout?: OperationAuditReleaseRolloutLinkage,
  ) {
    super(message);
    this.name = "FleetMutationPartialError";
  }
}

export class FleetMutationRefusedError extends Error {
  constructor(readonly refusal: Error, readonly partialOutcome?: OperationAuditPartialOutcome) {
    super(refusal.message);
    this.name = "FleetMutationRefusedError";
  }
}

export interface NormalFleetMutationInput<T> extends OperationAuditIntentInput {
  claimId?: string;
  action: (claim: OperationAuditActionClaim) => Promise<T>;
  classifyResult?: (result: T) => NormalFleetMutationResult;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedOutcomeDetails(error: unknown): Omit<Extract<NormalFleetMutationResult, { outcome: "failed" }>, "outcome" | "error"> {
  if (error instanceof FleetMutationRefusedError) return error.partialOutcome ? { partialOutcome: error.partialOutcome } : {};
  if (!(error instanceof FleetMutationPartialError)) return {};
  return {
    partialOutcome: error.partialOutcome,
    ...(error.aliasOutcomes ? { aliasOutcomes: error.aliasOutcomes } : {}),
    ...(error.releaseRollout ? { releaseRollout: error.releaseRollout } : {}),
  };
}

function logMutationFinished(logged: Record<string, unknown>, outcome: NormalFleetMutationResult, durationMs: number): void {
  const finished = { ...logged, outcome: outcome.outcome, durationMs };
  if (outcome.outcome === "completed") logger.info("fleet mutation finished", finished);
  else logger.warn("fleet mutation finished", { ...finished, ...(outcome.outcome === "failed" ? { error: outcome.error } : {}) });
}

export async function runNormalFleetMutation<T>(
  store: PlatformStateStore,
  input: NormalFleetMutationInput<T>,
): Promise<T> {
  const { action, claimId, classifyResult, idempotencyKey, ...intent } = input;
  const audit = await recordOperationAuditIntent(store, {
    ...intent,
    idempotencyKey: idempotencyKey ?? randomUUID(),
  });
  if (audit.disposition === "existing") {
    throw new FleetMutationIdempotencyError(audit.auditId, audit.status);
  }
  const claim = await claimOperationAuditAction(store, audit.auditId, {
    claimId: claimId ?? randomUUID(),
  });
  const logged = { auditId: audit.auditId, what: intent.what, why: intent.why, actor: intent.actor, forced: intent.forced, target: intent.target };
  const startedAt = Date.now();
  logger.info("fleet mutation started", logged);
  let result: T;
  let outcome: NormalFleetMutationResult;
  try {
    result = await action(claim);
    outcome = classifyResult?.(result) ?? { outcome: "completed" };
  } catch (error) {
    const failed = { ...logged, error: failureMessage(error), durationMs: Date.now() - startedAt };
    if (error instanceof FleetMutationRefusedError) logger.warn("fleet mutation refused", failed);
    else logger.error("fleet mutation failed", failed);
    try {
      await finishOperationAudit(store, audit.auditId, {
        expectedClaimId: claim.claimId,
        outcome: "failed",
        error: failureMessage(error),
        ...failedOutcomeDetails(error),
      });
    } catch (completionError) {
      throw new AggregateError(
        [error, completionError],
        `operation audit ${audit.auditId} action failed and its failure could not be recorded`,
      );
    }
    throw error;
  }
  await finishOperationAudit(store, audit.auditId, {
    expectedClaimId: claim.claimId,
    ...outcome,
  });
  logMutationFinished(logged, outcome, Date.now() - startedAt);
  return result;
}
