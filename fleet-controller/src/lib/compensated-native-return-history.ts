import type { OperationRecord } from "@octogee/core/platform-state";

export const COMPENSATED_NATIVE_RETURN_RESULT = "compensating Native return completed on original source";

export function staleCompensatedReturnAttempt(operation: OperationRecord, oldTarget: string) {
  const attempt = operation.attemptHistory?.at(-1);
  const target = operation.input.toGatewayId;
  return attempt && [
    operation.kind === "migrate-user", operation.origin === "automatic", operation.status === "pending",
    operation.input.source === "builder-activation-lease", operation.startedAt === null, operation.completedAt === null,
    typeof target === "string", target === operation.gatewayId, target !== oldTarget, Array.isArray(operation.steps), operation.steps?.length === 0,
    operation.rolledBack === undefined, operation.error === undefined, operation.output === undefined,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined,
    operation.userMigrationV2 === undefined, operation.sourceTransferExecution === undefined, operation.restoreAttempt === undefined,
    operation.lastProgressAt === undefined, operation.nextAttemptAt === undefined, operation.waitingOn === undefined,
    operation.schedulerHandoffReleased === true, operation.schedulerHandoff?.toGatewayId === oldTarget,
    operation.attempts === attempt.attempt, attempt.classification === "terminal", attempt.error === COMPENSATED_NATIVE_RETURN_RESULT,
    Array.isArray(attempt.steps), attempt.steps?.length === 0, Number.isSafeInteger(attempt.startedAt), Number.isSafeInteger(attempt.completedAt),
    attempt.startedAt <= attempt.completedAt,
  ].every(Boolean) ? attempt : null;
}
