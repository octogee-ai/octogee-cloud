import type { SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { UserMigrationV2State, Operation, OperationStep } from "@octogee/shared/types/glm";
import type { OperationContext } from "./operation-router.js";

export interface PersistFn {
  (steps: OperationStep[]): Promise<void>;
}

export interface CreateOperationContextDeps {
  assertActiveClaim?: (allowCancelled?: boolean) => Promise<void>;
  userRestore?: {
    assertSettled: () => Promise<void>;
    begin: (input: Parameters<NonNullable<OperationContext["withUserRestoreFence"]>>[0]) => Promise<() => Promise<void>>;
  };
  
  persist: PersistFn;
  persistSchedulerHandoff?: (state: SchedulerHandoffState) => Promise<void>;
  persistUserMigrationV2?: (state: UserMigrationV2State) => Promise<void>;
  persistCutoverCommitted?: (at: number) => Promise<void>;
  cancellationRequested?: () => Promise<boolean>;
  log: (msg: string) => void;
  
  opId: string;
}

function describeStepReport(opId: string, step: OperationStep): string {
  const finished = step.status !== "running" && step.status !== "pending";
  const duration = finished && typeof step.startedAt === "number" && typeof step.completedAt === "number"
    ? ` durationMs=${step.completedAt - step.startedAt}`
    : "";
  const failure = step.error ? `: ${step.error}` : "";
  return `[glm-controller] op=${opId} step=${step.name} status=${step.status}${duration}${failure}`;
}

export function operationElapsed(op: Pick<Operation, "startedAt">, now: number): string {
  return typeof op.startedAt === "number" ? ` after ${now - op.startedAt}ms` : "";
}

export function createOperationContext(deps: CreateOperationContextDeps): {
  ctx: OperationContext;
  steps: OperationStep[];
} {
  const steps: OperationStep[] = [];

  const ctx: OperationContext = {
    ...(deps.assertActiveClaim ? { assertActiveClaim: deps.assertActiveClaim } : {}),
    ...(deps.userRestore ? {
      assertUserRestoreSettled: deps.userRestore.assertSettled,
      withUserRestoreFence: async (input, work) => {
        const acknowledge = await deps.userRestore!.begin(input);
        await work();
        await acknowledge();
      },
    } : {}),
    reportStep: async (step: OperationStep) => {
      const idx = steps.findIndex(
        (s) => s.name === step.name && (s.status === "running" || s.status === "pending"),
      );
      const merged = idx >= 0 ? { ...(steps.at(idx) ?? step), ...step } : step;
      if (idx >= 0) steps.splice(idx, 1, merged);
      else steps.push(step);
      deps.log(describeStepReport(deps.opId, merged));
      try {
        await deps.persist([...steps]);
      } catch (err) {
        deps.log(
          `[glm-controller] ⚠ reportStep persist failed op=${deps.opId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    ...(deps.persistSchedulerHandoff ? { persistSchedulerHandoff: deps.persistSchedulerHandoff } : {}),
    ...(deps.persistUserMigrationV2
      ? { persistUserMigrationV2: deps.persistUserMigrationV2 }
      : {}),
    ...(deps.persistCutoverCommitted
      ? { persistCutoverCommitted: deps.persistCutoverCommitted }
      : {}),
    ...(deps.cancellationRequested
      ? { cancellationRequested: deps.cancellationRequested }
      : {}),
  };

  return { ctx, steps };
}

export function assertActiveOperationClaim(
  claimed: Operation,
  fresh: (Operation & { cancellationRequestedAt?: unknown }) | null,
  allowCancelled = false,
): void {
  if (claimed.status !== "running" || typeof claimed.startedAt !== "number" ||
      !fresh || fresh.status !== "running" || fresh.startedAt !== claimed.startedAt ||
      (!allowCancelled && fresh.cancellationRequestedAt !== undefined) || fresh.kind !== claimed.kind ||
      fresh.input.uid !== claimed.input.uid || fresh.input.fromGatewayId !== claimed.input.fromGatewayId ||
      fresh.input.toGatewayId !== claimed.input.toGatewayId) {
    throw new Error("operation claim is no longer active for this migration attempt");
  }
}

function positiveRestoreTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonblankRestoreIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class PendingUserRestoreError extends Error {
  override readonly name = "PendingUserRestoreError";
}

export function assertUserRestoreSettled(operation: Operation, attempt: unknown): void {
  if (attempt === undefined) return;
  if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) {
    throw new Error("user restore receipt is malformed; assignment fence retained");
  }
  const receipt = attempt as Record<string, unknown>;
  const identifiers = [receipt.slug, receipt.attemptId, receipt.operationId, receipt.uid, receipt.fromGatewayId, receipt.gatewayId];
  const exact = [
    receipt.phase === "acknowledged" || receipt.phase === "dispatched",
    identifiers.every(nonblankRestoreIdentifier),
    receipt.operationId === operation.id,
    receipt.uid === operation.input.uid,
    receipt.fromGatewayId === operation.input.fromGatewayId,
    receipt.gatewayId === operation.input.toGatewayId,
    operation.input.userSlug === undefined || receipt.slug === operation.input.userSlug,
    Number.isSafeInteger(receipt.assignmentEpoch) && (receipt.assignmentEpoch as number) >= 0,
    positiveRestoreTimestamp(receipt.claimStartedAt),
    positiveRestoreTimestamp(receipt.dispatchedAt),
  ].every(Boolean);
  if (!exact) throw new Error("user restore delivery remains ambiguous; assignment fence retained");
  if (receipt.phase === "dispatched") throw new PendingUserRestoreError("user restore awaits native target resumption; assignment fence retained");
  if (!positiveRestoreTimestamp(receipt.acknowledgedAt) || receipt.acknowledgedAt < (receipt.dispatchedAt as number)) {
    throw new Error("user restore acknowledgement is malformed; assignment fence retained");
  }
}
