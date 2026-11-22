import { hasUserActivationTargetRollback } from './user-activation-roll-recovery.js';
import { isUserActivateOperationIdFor, isUserReturnOperationIdFor } from "@octogee/shared/types/isolated-operation-ids";
import { readSchedulerMigrationIdentity, type Operation } from "@octogee/shared/types/glm";
import { fleetOperationLockResources, serialFleetOperationsConflict, type RolloutLane } from "@octogee/core/fleet-operation-lock";
import { PARKED_PREWARM_KIND } from "@octogee/core/isolated-gateway-lifecycle";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";

const ACCOUNT_SUSPENSION_KIND = "suspend-user";
export const PARKED_PREWARM_CONCURRENCY = 3;

export const SERIALLY_EXCLUSIVE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  MIGRATE_USER_KIND,
  ACCOUNT_SUSPENSION_KIND,
]);

export function isSeriallyExclusiveKind(kind: string): boolean {
  return SERIALLY_EXCLUSIVE_OPERATION_KINDS.has(kind);
}

export interface OperationRef {
  origin?: string;
  unstartedBuilderReturn?: boolean;
  gatewayCompatibilityPending?: boolean;
  schedulerHandoff?: unknown;
  id: string;
  kind: string;
  rolloutLane?: RolloutLane;
  input?: Record<string, unknown>;
  userMigrationV2?: {
    sourceGatewayId?: string;
    sourceRevisionId?: string;
    targetGatewayId?: string;
    targetRevisionId?: string;
  };
  cutoverCommittedAt?: number;
}

export interface SerialConflict {
  conflictingOpId: string;
  waitingOn: string;
}

export function findRunningRolloutParentOperationId(
  gatewayId: string,
  runningOperations: ReadonlyArray<OperationRef>,
): string | null {
  const matches = runningOperations.filter((operation) =>
    operation.kind === "rollout" &&
    (operation.input?.gatewayId === gatewayId || operation.input?.fromGatewayId === gatewayId)
  );
  if (matches.length > 1) {
    throw new Error(`multiple running rollout operations target gateway ${gatewayId}`);
  }
  return matches[0]?.id ?? null;
}

function operationsConflict(candidate: OperationRef, other: OperationRef): boolean {
  if (candidate.kind === ACCOUNT_SUSPENSION_KIND || other.kind === ACCOUNT_SUSPENSION_KIND) {
    return candidate.kind === other.kind;
  }
  return serialFleetOperationsConflict(candidate, other);
}

export function findSerialConflict(
  candidate: OperationRef,
  runningOpsSameKind: ReadonlyArray<OperationRef>,
): SerialConflict | null {
  const conflict = runningOpsSameKind.find(
    (running) => running.id !== candidate.id && operationsConflict(candidate, running),
  );
  if (!conflict) return null;
  return { conflictingOpId: conflict.id, waitingOn: describeWaitingOn(conflict) };
}

function inputString(input: OperationRef["input"], key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function rolloutWaitingOn(input: OperationRef["input"]): string | null {
  const gatewayId = inputString(input, "gatewayId");
  if (!gatewayId) return null;
  const imageTag = inputString(input, "imageTag");
  return imageTag ? `roll ${gatewayId} → ${imageTag}` : `roll ${gatewayId}`;
}

function migrationWaitingOn(input: OperationRef["input"]): string | null {
  const toGatewayId = inputString(input, "toGatewayId");
  if (!toGatewayId) return null;
  const fromGatewayId = inputString(input, "fromGatewayId");
  return fromGatewayId ? `migration ${fromGatewayId} → ${toGatewayId}` : `migration → ${toGatewayId}`;
}

const WAITING_ON_DESCRIPTIONS: Readonly<Record<string, (input: OperationRef["input"]) => string | null>> = {
  rollout: rolloutWaitingOn,
  [MIGRATE_USER_KIND]: migrationWaitingOn,
  [ACCOUNT_SUSPENSION_KIND]: () => "another account suspension",
};

function describeWaitingOn(op: OperationRef): string {
  return WAITING_ON_DESCRIPTIONS[op.kind]?.(op.input) ?? `another ${op.kind} operation`;
}

export interface PendingOperationRef extends OperationRef {
  sharedDestinationReleased?: boolean;
  unstartedPlacementMove?: boolean;
  createdAt: number;
  queuedAt?: number;
  nextAttemptAt?: number | null;
}

export interface OperationClaimCandidate extends OperationRef {
  status: string;
  createdAt: number;
  queuedAt?: number;
  nextAttemptAt?: number | null;
}

export interface OperationClaimDecisionInput {
  op: OperationClaimCandidate;
  now: number;
  runningOpsSameKind: ReadonlyArray<OperationRef>;
  pendingOpsSameKind: ReadonlyArray<PendingOperationRef>;
}

export type OperationClaimDecision =
  | { outcome: "skip" }
  | { outcome: "claim" }
  | { outcome: "queue"; waitingOn: string };

export function compareOperationQueueOrder(
  a: { createdAt: number; queuedAt?: number; id: string },
  b: { createdAt: number; queuedAt?: number; id: string },
): number {
  const timeDifference = (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt);
  if (timeDifference !== 0) return timeDifference;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function postCutoverReturnBlocksRollout(rollout: OperationRef, returning: OperationRef): boolean {
  return rollout.kind === "rollout" && returning.kind === MIGRATE_USER_KIND &&
    typeof returning.cutoverCommittedAt === "number" && operationsConflict(rollout, returning);
}

function heldNativeReturnSource(operation: OperationRef): string | undefined {
  if (operation.kind !== MIGRATE_USER_KIND || operation.cutoverCommittedAt !== undefined ||
      operation.input?.source !== "builder-activation-lease") return;
  const source = inputString(operation.input, "fromGatewayId");
  const target = inputString(operation.input, "toGatewayId");
  const handoff = operation.schedulerHandoff as Operation["schedulerHandoff"];
  const recovery = handoff?.forwardRecovery;
  if (source && !source.startsWith("shared-") && target?.startsWith("shared-") &&
      isUserReturnOperationIdFor(operation.id, source) && handoff?.fromGatewayId === source &&
      handoff.toGatewayId === target && readSchedulerMigrationIdentity(operation.id, handoff.migrationId) &&
      recovery?.schemaVersion === 1 && recovery.phase === "source-flushed" &&
      Number.isSafeInteger(recovery.sourceEpoch) && recovery.sourceEpoch >= 0) return source;
}

function vmRolloutGateway(operation: OperationRef): string | undefined {
  if (operation.kind === "rollout" && operation.rolloutLane === "builder-vm") return inputString(operation.input, "gatewayId");
}

function isBackingOffReleasedOperation(pending: PendingOperationRef, now: number): boolean {
  return (pending.kind === ACCOUNT_SUSPENSION_KIND ||
    pending.kind === MIGRATE_USER_KIND && pending.queuedAt !== undefined) &&
    typeof pending.nextAttemptAt === "number" &&
    pending.nextAttemptAt > now;
}

function rolloutWaitsForUserActivation(rollout: OperationRef, activation: OperationRef): boolean {
  const target = inputString(activation.input, "toGatewayId");
  return rollout.kind === "rollout" &&
    activation.kind === MIGRATE_USER_KIND &&
    activation.input?.source === "builder-activation-lease" &&
    isUserActivateOperationIdFor(activation.id, target) &&
    !compatibilityWaitYieldsToRoll(activation, rollout) &&
    !recoveryYieldsToTargetRoll(activation, rollout) &&
    typeof activation.cutoverCommittedAt !== "number" &&
    rollout.input?.gatewayId === target;
}

function compatibilityWaitYieldsToRoll(waiting: OperationRef, rollout: OperationRef): boolean {
  return waiting.kind === MIGRATE_USER_KIND && waiting.gatewayCompatibilityPending === true && waiting.schedulerHandoff === undefined &&
    rollout.kind === "rollout" && operationsConflict(waiting, rollout);
}

function recoveryYieldsToTargetRoll(recovery: OperationRef, rollout: OperationRef): boolean {
  const target = inputString(recovery.input, "toGatewayId");
  return recovery.kind === MIGRATE_USER_KIND &&
    recovery.input?.source === "builder-activation-lease" &&
    recovery.input.recoverSourceOnly === true &&
    !hasUserActivationTargetRollback(recovery) &&
    inputString(recovery.input, "fromGatewayId")?.startsWith("shared-") === true &&
    recovery.userMigrationV2 === undefined &&
    typeof recovery.cutoverCommittedAt !== "number" &&
    isUserActivateOperationIdFor(recovery.id, target) &&
    rollout.kind === "rollout" && rollout.rolloutLane === "cluster" && rollout.input?.gatewayId === target;
}

function absentOrEmpty(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.length === 0;
}

function hasNoInvocationHistory(operation: Operation): boolean {
  return operation.startedAt === null && operation.completedAt === null &&
    (operation.firstStartedAt === undefined || operation.firstStartedAt === null) &&
    [operation.attempts, operation.resumeCount].every(value => value === undefined || value === 0) &&
    (operation.rolledBack === undefined || operation.rolledBack === false) &&
    Array.isArray(operation.steps) && operation.steps.length === 0 &&
    absentOrEmpty(operation.attemptHistory) && absentOrEmpty(operation.progress);
}

function hasNoRuntimeEffects(operation: Operation): boolean {
  return !("cancellationRequestedAt" in operation) &&
    [operation.lastResumedAt, operation.lastProgressAt, operation.error, operation.output,
      operation.userMigrationV2, operation.sourceTransferExecution, operation.schedulerHandoff,
      operation.schedulerHandoffReleased, operation.schedulerHandoffReleasedAt, operation.schedulerHandoffLost,
      operation.cutoverCommittedAt].every(value => value === undefined);
}

export function isUnstartedUserReturn(operation: Operation): boolean {
  const source = inputString(operation.input, "fromGatewayId");
  const target = inputString(operation.input, "toGatewayId");
  return operation.kind === MIGRATE_USER_KIND && operation.status === "pending" &&
    operation.origin === "automatic" && operation.input?.source === "builder-activation-lease" &&
    isUserReturnOperationIdFor(operation.id, source) && target?.startsWith("shared-") === true &&
    operation.input.recoverSourceOnly === undefined && hasNoInvocationHistory(operation) && hasNoRuntimeEffects(operation);
}

export function isUnstartedSharedPlacementMove(operation: Operation): boolean {
  const source = inputString(operation.input, "fromGatewayId");
  const target = inputString(operation.input, "toGatewayId");
  return operation.kind === MIGRATE_USER_KIND && operation.status === "pending" &&
    operation.origin === "automatic" && operation.input?.source === "continuous-placement-policy" &&
    source?.startsWith("shared-") === true && target?.startsWith("shared-") === true && source !== target &&
    hasNoInvocationHistory(operation) && hasNoRuntimeEffects(operation);
}

function returnMatchesOperatorRoll(returning: OperationRef, rollout: OperationRef): boolean {
  return returning.unstartedBuilderReturn === true && rollout.kind === "rollout" && rollout.origin === "operator" &&
    returning.input?.fromGatewayId === rollout.input?.gatewayId;
}

function blocksOperatorPriorityRoll(rollout: PendingOperationRef, pending: PendingOperationRef, now: number): boolean {
  if (rolloutWaitsForUserActivation(rollout, pending)) return true;
  return !compatibilityWaitYieldsToRoll(pending, rollout) && !returnMatchesOperatorRoll(pending, rollout) && !recoveryYieldsToTargetRoll(pending, rollout) &&
    !isBackingOffReleasedOperation(pending, now) && operationsConflict(rollout, pending) &&
    compareOperationQueueOrder(pending, rollout) < 0;
}

function eligibleOperatorPriorityRolls(input: OperationClaimDecisionInput): ReadonlySet<string> {
  const byId = new Map(input.pendingOpsSameKind.map(operation => [operation.id, operation]));
  byId.set(input.op.id, input.op);
  const pending = [...byId.values()];
  return new Set(pending.filter(rollout =>
    rollout.kind === "rollout" && rollout.origin === "operator" &&
    (typeof rollout.nextAttemptAt !== "number" || rollout.nextAttemptAt <= input.now) &&
    findSerialConflict(rollout, input.runningOpsSameKind) === null &&
    !pending.some(peer => peer.id !== rollout.id && blocksOperatorPriorityRoll(rollout, peer, input.now)),
  ).map(rollout => rollout.id));
}

function unstartedReturnYieldsToOperatorRoll(returning: OperationRef, rollout: OperationRef, eligible: ReadonlySet<string>): boolean {
  return eligible.has(rollout.id) && returnMatchesOperatorRoll(returning, rollout);
}

function isPendingUserActivation(operation: OperationRef): boolean {
  return operation.kind === MIGRATE_USER_KIND &&
    operation.input?.source === "builder-activation-lease" &&
    isUserActivateOperationIdFor(operation.id, inputString(operation.input, "toGatewayId")) &&
    operation.userMigrationV2 === undefined &&
    typeof operation.cutoverCommittedAt !== "number";
}

function placementMoveYieldsToUserActivation(move: OperationRef, activation: OperationRef): boolean {
  const source = inputString(activation.input, "fromGatewayId");
  return isPendingUserActivation(activation) &&
    move.kind === MIGRATE_USER_KIND &&
    move.input?.source === "continuous-placement-policy" &&
    move.userMigrationV2 === undefined &&
    typeof move.cutoverCommittedAt !== "number" &&
    source !== undefined &&
    inputString(move.input, "fromGatewayId") === source;
}

type MigrationQueueScope = Pick<OperationRef, "id" | "kind" | "input" | "userMigrationV2">;

function usesOnlySharedDestination(candidate: MigrationQueueScope, backingOff: MigrationQueueScope): boolean {
  if (candidate.kind !== MIGRATE_USER_KIND || backingOff.kind !== MIGRATE_USER_KIND ||
      backingOff.input?.source !== "continuous-placement-policy") return false;
  const target = inputString(backingOff.input, "toGatewayId");
  const candidateUid = inputString(candidate.input, "uid");
  const backingOffUid = inputString(backingOff.input, "uid");
  if (!target?.startsWith("shared-") || inputString(candidate.input, "toGatewayId") !== target ||
      !candidateUid || !backingOffUid || candidateUid === backingOffUid) return false;
  const candidateResources = fleetOperationLockResources(candidate);
  return [...fleetOperationLockResources(backingOff)].every(resource => resource === target || !candidateResources.has(resource));
}

export function usesOnlySharedDestinationWhileBackingOff(
  candidate: MigrationQueueScope,
  backingOff: MigrationQueueScope & Pick<PendingOperationRef, "nextAttemptAt">,
  now: number,
): boolean {
  return (backingOff.nextAttemptAt ?? now) > now && usesOnlySharedDestination(candidate, backingOff);
}

function releasedSharedDestinationHeads(candidate: PendingOperationRef, pending: readonly PendingOperationRef[], now: number) {
  const bySource = new Map<string, PendingOperationRef>();
  for (const operation of pending) {
    const source = inputString(operation.input, "fromGatewayId");
    if (!source || !operation.sharedDestinationReleased ||
        !usesOnlySharedDestinationWhileBackingOff(candidate, operation, now)) continue;
    const earlier = bySource.get(source);
    if (!earlier || compareOperationQueueOrder(operation, earlier) < 0) bySource.set(source, operation);
  }
  return bySource;
}

function sharesReleasedDestination(
  candidate: PendingOperationRef,
  pending: PendingOperationRef,
  heads: ReadonlyMap<string, PendingOperationRef>,
): boolean {
  const source = inputString(pending.input, "fromGatewayId");
  if (!source || !usesOnlySharedDestination(candidate, pending)) return false;
  const head = heads.get(source);
  if (!head) return false;
  return head.id === pending.id ||
    pending.unstartedPlacementMove === true && compareOperationQueueOrder(head, pending) < 0;
}

function findOlderPendingSameScope(
  candidate: PendingOperationRef,
  pendingOpsSameKind: ReadonlyArray<PendingOperationRef>,
  now: number,
  eligibleRolls: ReadonlySet<string>,
): SerialConflict | null {
  const releasedDestinations = releasedSharedDestinationHeads(candidate, pendingOpsSameKind, now);
  const older = pendingOpsSameKind
    .filter(
      (pending) =>
        pending.id !== candidate.id &&
        !rolloutWaitsForUserActivation(pending, candidate) &&
        !postCutoverReturnBlocksRollout(pending, candidate) &&
        !recoveryYieldsToTargetRoll(pending, candidate) &&
        !compatibilityWaitYieldsToRoll(pending, candidate) &&
        !unstartedReturnYieldsToOperatorRoll(pending, candidate, eligibleRolls) &&
        !placementMoveYieldsToUserActivation(pending, candidate) &&
        !isBackingOffReleasedOperation(pending, now) &&
        !sharesReleasedDestination(candidate, pending, releasedDestinations) &&
        operationsConflict(candidate, pending) &&
        compareOperationQueueOrder(pending, candidate) < 0,
    )
    .sort(compareOperationQueueOrder)[0];
  if (!older) return null;
  return { conflictingOpId: older.id, waitingOn: describeWaitingOn(older) };
}

// Pure decision core for the operation worker's claim transaction: given a
// pending op, the OTHER currently-running ops of its kind, and the other
// pending ops of its kind (all read inside the same Firestore transaction the
// caller wraps this in), decide whether to claim it now, leave it queued, or
// skip it (already claimed elsewhere, or its retry backoff hasn't elapsed).
// Never returns a terminal-failure outcome — a serial-invariant conflict is
// not a validation failure, it is a scheduling fact.
export function decideOperationClaim(
  input: OperationClaimDecisionInput,
): OperationClaimDecision {
  const { op, now, runningOpsSameKind, pendingOpsSameKind } = input;
  if (op.status !== "pending") return { outcome: "skip" };
  if (typeof op.nextAttemptAt === "number" && op.nextAttemptAt > now) {
    return { outcome: "skip" };
  }
  if (op.kind === PARKED_PREWARM_KIND) {
    const prewarms = runningOpsSameKind.filter(running => running.kind === PARKED_PREWARM_KIND && running.id !== op.id);
    const owner = inputString(op.input, "uid");
    if (owner && prewarms.some(running => inputString(running.input, "uid") === owner)) {
      return { outcome: "queue", waitingOn: "the owner's parked computer upgrade" };
    }
    return prewarms.length >= PARKED_PREWARM_CONCURRENCY
      ? { outcome: "queue", waitingOn: "a parked computer upgrade slot" }
      : { outcome: "claim" };
  }
  const runningConflict = findSerialConflict(op, runningOpsSameKind);
  if (runningConflict) return { outcome: "queue", waitingOn: runningConflict.waitingOn };
  let pendingInScope = pendingOpsSameKind;
  const rolloutGateway = vmRolloutGateway(op);
  if (rolloutGateway) {
    const heldSources = new Map<string, OperationRef>();
    for (const migration of [...runningOpsSameKind, ...pendingOpsSameKind]) {
      const source = heldNativeReturnSource(migration);
      if (source) heldSources.set(source, migration);
    }
    const sourceReturn = heldSources.get(rolloutGateway);
    if (sourceReturn) return { outcome: "queue", waitingOn: describeWaitingOn(sourceReturn) };
    pendingInScope = pendingOpsSameKind.filter(pending => {
      const gateway = vmRolloutGateway(pending);
      return gateway === undefined || !heldSources.has(gateway);
    });
  }
  const postCutoverReturn = pendingInScope.find((pending) =>
    pending.id !== op.id && postCutoverReturnBlocksRollout(op, pending));
  if (postCutoverReturn) return { outcome: "queue", waitingOn: describeWaitingOn(postCutoverReturn) };
  const eligibleRolls = eligibleOperatorPriorityRolls({ ...input, pendingOpsSameKind: pendingInScope });
  const activation = pendingInScope.find((pending) =>
    rolloutWaitsForUserActivation(op, pending) || placementMoveYieldsToUserActivation(op, pending) ||
    recoveryYieldsToTargetRoll(op, pending) || compatibilityWaitYieldsToRoll(op, pending) || unstartedReturnYieldsToOperatorRoll(op, pending, eligibleRolls));
  if (activation) return { outcome: "queue", waitingOn: describeWaitingOn(activation) };
  const olderPending = findOlderPendingSameScope(op, pendingInScope, now, eligibleRolls);
  if (olderPending) return { outcome: "queue", waitingOn: olderPending.waitingOn };
  return { outcome: "claim" };
}
