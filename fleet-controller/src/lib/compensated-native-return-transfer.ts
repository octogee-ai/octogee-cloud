import { isDeepStrictEqual } from "node:util";
import { NATIVE_RETURN_TARGET_EXCLUSION, nativeReturnTargetDenied, nativeReturnTargetExclusionId } from "@octogee/core/fleet-state";
import type { GatewayAssignment, MigrationTransferTask, OperationRecord, PlatformStateTransaction, UserActivationLease } from "@octogee/core/platform-state";
import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";

type Audit = NonNullable<Awaited<ReturnType<PlatformStateTransaction["journal"]["audits"]["get"]>>>;
type HistoricalTask = MigrationTransferTask & { completedAt: number };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactCurrentScheduler(
  op: OperationRecord, task: HistoricalTask, target: string, restored: Record<string, unknown>, cleanup: boolean,
): boolean {
  const restoredAt = restored.restoredAt;
  const claim = op.schedulerHandoff;
  const identity = readSchedulerMigrationIdentity(op.id, claim?.migrationId);
  if (!claim || !identity || typeof restoredAt !== "number" || typeof op.startedAt !== "number") return false;
  if (![
    op.startedAt > restoredAt, identity.claimStartedAt > restoredAt, claim.toGatewayId === target,
    claim.fromGatewayId === task.sourceGatewayId, claim.uid === op.inputUid, claim.slug === task.slug,
  ].every(Boolean)) return false;
  if (identity.claimStartedAt === op.startedAt) return identity.attempt === (op.attempts ?? 0) + 1;
  const forward = claim.forwardRecovery;
  return [
    cleanup || (forward?.phase === "source-flushed" && forward.sourceEpoch === restored.sourceEpoch),
    identity.claimStartedAt < op.startedAt,
    op.attemptHistory?.some(attempt => attempt.attempt === identity.attempt &&
      attempt.startedAt === identity.claimStartedAt && attempt.completedAt <= op.startedAt!),
  ].every(Boolean);
}

function verifiedCompensation(
  audit: Audit, operation: OperationRecord, task: HistoricalTask, selection: Record<string, unknown>,
  scope: Record<string, unknown>,
): boolean {
  const archived = object(object(audit.target.archivedReturn)?.handoff);
  const completedAt = audit.completedAt;
  if (!archived || typeof completedAt !== "number" || !audit.actionClaimId) return false;
  return [
    audit.status === "completed", audit.outcome === "completed", audit.lifecycleStage === "action-completed",
    audit.actionClaimId === audit.mutation.attemptId, isDeepStrictEqual(audit.mutation.scope, scope),
    Object.entries(scope).every(([key, value]) => audit.target[key] === value),
    object(audit.target.original), isDeepStrictEqual(audit.mutation.source, audit.target.original),
    archived.migrationId === selection.schedulerMigrationId, archived.fromGatewayId === task.sourceGatewayId,
    archived.toGatewayId === task.targetGatewayId, archived.uid === operation.inputUid, archived.slug === task.slug,
    object(archived.forwardRecovery)?.sourceEpoch === selection.sourceEpoch,
    readSchedulerMigrationIdentity(operation.id, archived.migrationId),
  ].every(Boolean);
}

function leaseMatchesCompensation(
  lease: UserActivationLease, assignment: GatewayAssignment, op: OperationRecord, restored: Record<string, unknown>,
): boolean {
  return [
    builderReturnOperationId(assignment.gatewayId, lease.generation) === op.id, lease.targetGatewayId === assignment.gatewayId,
    lease.leaseId === restored.leaseId, lease.generation === restored.generation, lease.activeAt === restored.restoredAt,
    (lease.status === "returning" && lease.returnOperationId === op.id) ||
      (lease.status === "active" && lease.returnOperationId === undefined && assignment.state === "serving"),
  ].every(Boolean);
}

async function matchesCurrentOwner(
  tx: PlatformStateTransaction, op: OperationRecord & { inputUid: string }, task: HistoricalTask, currentTarget: string,
  restored: Record<string, unknown>,
): Promise<boolean> {
  const uid = op.inputUid;
  const [owner, assignments, roots] = await Promise.all([
    tx.users.records.get(uid), tx.gateways.assignments.listForUid(uid),
    tx.gateways.roots.getMany([task.sourceGatewayId, currentTarget]),
  ]);
  const original = roots.get(task.sourceGatewayId);
  const allocation = original?.allocation;
  const target = roots.get(currentTarget);
  const assignment = assignments[0];
  const lease = owner?.activationLease;
  if (!owner || !lease || !allocation || !assignment || !original || !target) return false;
  const currentMigration = owner.fences.migration;
  return [
    owner.slug === task.slug, owner.gateway?.gatewayId === task.sourceGatewayId,
    Object.keys(owner.fences).every(key => key === "migration"), !currentMigration || currentMigration.operationId === op.id,
    assignments.length === 1, assignment.slug === task.slug, assignment.gatewayId === task.sourceGatewayId,
    assignment.epoch === restored.sourceEpoch,
    assignment.state === "serving" || (assignment.state === "quiescing" && assignment.updatedByOperationId === op.id && currentMigration?.operationId === op.id),
    leaseMatchesCompensation(lease, assignment, op, restored),
    original.gatewayClass === "isolated", original.ownerUid === uid, original.builderSlug === task.slug,
    original.desiredStatus === "running", !original.runtimeRestartFence, !original.retirementClaim, allocation.kind === "disposable-builder",
    allocation.claimedByUid === uid, allocation.leaseId === lease.leaseId, allocation.generation === lease.generation,
    target.gatewayClass === "shared", target.desiredStatus === "running", target.liveRelease !== null,
    target.liveRelease === target.desiredRelease, !target.retirementClaim, !target.runtimeRestartFence,
  ].every(Boolean);
}

function readRestoration(audit: Audit) {
  const restored = object(audit.target.retiredLeaseRestoration);
  const selection = object(object(audit.target.reservation)?.selection);
  const release = object(audit.target.sharedHandoffRelease);
  const retirement = object(release?.retirement);
  if (!restored || !selection || !release || !retirement || typeof restored.compensationAuditId !== "string" ||
      typeof restored.restoredAt !== "number" || typeof retirement.createdAt !== "number" ||
      typeof retirement.completedAt !== "number" || typeof release.verifiedAt !== "number") return null;
  return { restored, selection, releasedAt: release.verifiedAt, actor: release.actor, compensationId: restored.compensationAuditId,
    restoredAt: restored.restoredAt, retirementCreatedAt: retirement.createdAt, retirementCompletedAt: retirement.completedAt };
}

function matchesRetiredExclusion(audit: Audit, operation: OperationRecord, task: HistoricalTask, restored: NonNullable<ReturnType<typeof readRestoration>>) {
  const scope = restored.selection;
  return [
    audit.status === "completed", audit.outcome === "completed", audit.actionClaimId === audit.id,
    audit.mutation.kind === NATIVE_RETURN_TARGET_EXCLUSION, audit.mutation.operationId === operation.id,
    audit.target.uid === operation.inputUid, audit.target.targetGatewayId === task.targetGatewayId,
    scope.operationId === operation.id, scope.sourceGatewayId === task.sourceGatewayId, scope.targetGatewayId === task.targetGatewayId,
    scope.sourceEpoch === restored.restored.sourceEpoch, Number.isSafeInteger(restored.restored.sourceEpoch),
    restored.restored.operationId === operation.id, restored.actor === audit.actor,
    task.completedAt <= restored.retirementCreatedAt, restored.retirementCompletedAt <= restored.releasedAt,
    restored.releasedAt <= restored.restoredAt,
  ].every(Boolean);
}

export async function compensatedReturnAllowsAlternateTransfer(
  tx: PlatformStateTransaction, operation: OperationRecord & { inputUid: string }, task: HistoricalTask, target: string, cleanup: boolean,
): Promise<boolean> {
  const uid = operation.inputUid;
  const exclusionId = nativeReturnTargetExclusionId(uid);
  const audit = await tx.journal.audits.get(exclusionId);
  const restoration = audit && readRestoration(audit);
  if (!audit || !restoration) return false;
  if (![
    target !== task.targetGatewayId, matchesRetiredExclusion(audit, operation, task, restoration),
    operation.input.compensatingNativeReturn === undefined, operation.input.recoverSourceOnly === undefined,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined,
    exactCurrentScheduler(operation, task, target, restoration.restored, cleanup),
  ].every(Boolean)) return false;
  const compensation = await tx.journal.audits.get(restoration.compensationId);
  if (!compensation || typeof compensation.completedAt !== "number" || compensation.completedAt > restoration.restoredAt ||
      compensation.completedAt < restoration.retirementCompletedAt ||
      !verifiedCompensation(compensation, operation, task, restoration.selection,
        { ...restoration.selection, uid, slug: task.slug, exclusionId })) return false;
  return !await nativeReturnTargetDenied(tx, uid, target) &&
    await matchesCurrentOwner(tx, operation, task, target, restoration.restored);
}
