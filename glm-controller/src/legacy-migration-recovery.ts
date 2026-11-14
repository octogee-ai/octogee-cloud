import { isUserActivateOperationIdFor } from "@octogee/core/user-activation-lease";
import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import type { PlatformUserRecord, GatewayAssignment, OperationPatch, PlatformStateStore, PlatformStateTransaction, Stored } from "@octogee/core/platform-state";
import { readSchedulerMigrationIdentity, type Operation, type SchedulerHandoffState } from "@octogee/shared/types/glm";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { userActivationRecoveryTargetMatches } from "@octogee/core/fleet-state";
import { classifyOperationFailure, retryBackoffMs } from "./operation-retry.js";
import { RETIRE_GATEWAY_KIND } from "./operation-kinds.js";

function handoffAttemptEvidence(operation: Partial<Operation>) {
  const handoff = operation.schedulerHandoff;
  const identity = readSchedulerMigrationIdentity(operation.id, handoff?.migrationId);
  if (!identity) return undefined;
  if (handoff?.sourceRecovery) {
    return handoff.sourceRecovery.migrationId === handoff.migrationId ? handoff.sourceRecovery : undefined;
  }
  const { attempt, claimStartedAt } = identity;
  const claimMatches = (startedAt: number | null | undefined) => claimStartedAt === startedAt;
  const prior = operation.attemptHistory?.slice().reverse().find((entry) => entry.attempt === attempt && claimMatches(entry.startedAt));
  const currentAttempt = operation.status === "running" ? (operation.attempts ?? 0) + 1 : operation.attempts;
  return prior ?? (currentAttempt === attempt && claimMatches(operation.startedAt) ? { steps: operation.steps } : undefined);
}

const SOURCE_HOLDING_STEP_STATUSES: ReadonlySet<string> = new Set(["running", "done", "failed"]);

export function attemptNeverHeldSource(operation: Partial<Operation>): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps !== undefined && steps.length > 0 &&
    !steps.some((step) => step.name === "quiesce-source" && SOURCE_HOLDING_STEP_STATUSES.has(step.status));
}

export function attemptMayHoldSourceIngress(operation: Partial<Operation>): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps ?? [];
  return steps.some((step) =>
    step.name === "wait-for-active-work" && (step.status === "running" || step.status === "done"));
}

function failedActivationHeldSource(operation: Partial<Operation>): boolean {
  return operation.input?.recoverSourceOnly === true || operation.schedulerHandoff?.forwardRecovery !== undefined ||
    handoffAttemptEvidence(operation)?.steps?.some((step) => step.name === "quiesce-source") !== false;
}

export function userActivationSourceRecoveryPending(operation: Partial<Operation>): boolean {
  const input = operation.input;
  return operation.kind === "migrate-user" && input?.source === "builder-activation-lease" &&
    isUserActivateOperationIdFor(operation.id, input.toGatewayId) &&
    typeof input.fromGatewayId === "string" && input.fromGatewayId.startsWith("shared-") &&
    operation.schedulerHandoff?.stageAfterCutover === true && operation.userMigrationV2 === undefined &&
    operation.cutoverCommittedAt === undefined && operation.rolledBack !== true &&
    (operation.status === "pending" || operation.status === "running" ||
      operation.status === "failed" && failedActivationHeldSource(operation));
}

export function releasedUserActivationSourceRecovery(operation: Partial<Operation>): boolean {
  const handoff = operation.schedulerHandoff;
  const checkpoint = handoff?.forwardRecovery;
  if (!handoff || !checkpoint || !userActivationSourceRecoveryPending(operation)) return false;
  const input = operation.input!;
  return [
    checkpoint.targetReleased === true, checkpoint.schemaVersion === 1, checkpoint.phase === "source-flushed",
    Number.isSafeInteger(checkpoint.sourceEpoch), checkpoint.sourceEpoch >= 0,
    readSchedulerMigrationIdentity(operation.id, handoff.migrationId) !== null,
    handoff.uid === input.uid, handoff.fromGatewayId === input.fromGatewayId,
    handoff.toGatewayId === input.toGatewayId, handoff.slug === input.userSlug,
    handoff.sourceRecovery === undefined || handoff.sourceRecovery.sourceEpoch === checkpoint.sourceEpoch,
  ].every(Boolean);
}

function preSyncFailedWithUnconfirmedUnmount(steps: Operation["steps"] | undefined): boolean {
  return steps?.length === 3 &&
    steps[0]?.name === "keys-sync-state" && steps[0].status === "done" &&
    steps[1]?.name === "pre-sync-state" && steps[1].status === "failed" &&
    steps[2]?.name === "rollback:unmount-target" && steps[2].status === "failed";
}

function failedPreSyncCleanup(operation: Operation): boolean {
  return preSyncFailedWithUnconfirmedUnmount(handoffAttemptEvidence(operation)?.steps);
}

function incompleteNativeCleanup(error: unknown): boolean {
  return typeof error === "string" &&
    /agent database files are still held open:|native cleanup incomplete: purgeFailed=(?:true failed=\[|false failed=\[[^\]])|deletion cleanup is still pending/.test(error);
}

function legacyHeldTargetCleanupPending(operation: Operation): boolean {
  return incompleteNativeCleanup(handoffAttemptEvidence(operation)?.steps?.[1]?.error) && failedPreSyncCleanup(operation);
}

function rollbackRecoveryPending(operation: Operation): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  const failures = steps?.filter((step) => step.name.startsWith("rollback:") && step.status === "failed") ?? [];
  return failures.length > 0 && (failures.some((step) => incompleteNativeCleanup(step.error) || classifyOperationFailure(step.error) === "transient") ||
    steps!.some((step) => !step.name.startsWith("rollback:") && step.status === "failed" && classifyOperationFailure(step.error) === "transient"));
}

export function sourceRecoveryForwardRetryable(operation: Partial<Operation>): boolean {
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps !== undefined && steps.filter((step) => !step.name.startsWith("rollback:") && step.status === "failed")
    .every((step) => incompleteNativeCleanup(step.error) || classifyOperationFailure(step.error) === "transient");
}

export function legacyAttemptNeverQuiesced(operation: Operation): boolean {
  if (operation.userMigrationV2 !== undefined ||
      !([operation.input.fromGatewayId, operation.input.toGatewayId].every((id) => typeof id === "string" && id.startsWith("shared-")) ||
        userActivationSourceRecoveryPending(operation))) return false;
  if (failedPreSyncCleanup(operation)) return true;
  const steps = handoffAttemptEvidence(operation)?.steps;
  return steps?.length === 1 && steps[0]?.name === "keys-sync-state" && steps[0].status === "failed";
}

function recoverableLegacyScope(operation: Operation & { cancellationRequestedAt?: number }): boolean {
  const input = operation.input;
  const handoff = operation.schedulerHandoff;
  if (!handoff || typeof input.fromGatewayId !== "string" || typeof input.toGatewayId !== "string") return false;
  const identity = readSchedulerMigrationIdentity(operation.id, handoff.migrationId);
  return [
    operation.kind === "migrate-user", operation.userMigrationV2 === undefined, handoff.forwardRecovery === undefined || releasedUserActivationSourceRecovery(operation),
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined,
    operation.sourceTransferExecution === undefined, input.sourceTransferMode === undefined,
    Array.isArray(operation.steps),
    typeof input.uid === "string", input.fromGatewayId.startsWith("shared-"), input.fromGatewayId !== input.toGatewayId,
    handoff.uid === input.uid, handoff.fromGatewayId === input.fromGatewayId, handoff.toGatewayId === input.toGatewayId,
    input.toGatewayId.startsWith("shared-") && handoff.stageAfterCutover !== true || userActivationSourceRecoveryPending(operation),
    identity !== null,
  ].every(Boolean);
}

function ownsLegacySource(operation: Operation, owner: Stored<PlatformUserRecord> | null, assignment: Stored<GatewayAssignment> | null, targetExists: boolean): boolean {
  if (!assignment || !owner?.gateway) return false;
  return [
    !isolatedRuntimeMutationFenced(owner), !targetExists, owner.gateway.gatewayId === operation.input.fromGatewayId,
    readWorkspaceMigrationMarker({ migration: owner.fences.migration })?.operationId === operation.id ||
      owner.fences.migration === undefined && assignment.state === "serving" && assignment.updatedByOperationId === operation.id,
    assignment.uid === operation.input.uid, assignment.gatewayId === operation.input.fromGatewayId,
    Number.isSafeInteger(assignment.epoch), assignment.epoch >= 0,
    assignment.state === "serving" || assignment.state === "quiescing" && assignment.updatedByOperationId === operation.id,
  ].every(Boolean);
}

function recoveryAttemptHistory(operation: Operation, now: number): { attempt: number; history: NonNullable<Operation["attemptHistory"]> } {
  const attempt = operation.status === "running"
    ? (operation.attempts ?? 0) + 1
    : Math.max(operation.attempts ?? 0, readSchedulerMigrationIdentity(operation.id, operation.schedulerHandoff!.migrationId)!.attempt);
  const currentAttempt = operation.status === "running" ? (operation.attempts ?? 0) + 1 : operation.attempts;
  const recorded = currentAttempt === attempt && !operation.attemptHistory?.some((entry) => entry.attempt === attempt) ? [{
    attempt, startedAt: operation.startedAt ?? now, completedAt: now,
    error: operation.error ?? "controller restarted mid-op; native source recovery required",
    classification: "transient" as const, steps: operation.steps,
  }] : [];
  return { attempt, history: [...operation.attemptHistory ?? [], ...recorded].slice(-20) };
}

function recoveryIntent(operation: Operation, sourceEpoch: number): NonNullable<SchedulerHandoffState["sourceRecovery"]> | null {
  const handoff = operation.schedulerHandoff!;
  const prior = handoff.sourceRecovery;
  if (prior) return prior.migrationId === handoff.migrationId && prior.sourceEpoch === sourceEpoch && Array.isArray(prior.steps) ? prior : null;
  const steps = releasedUserActivationSourceRecovery(operation) ? operation.steps : handoffAttemptEvidence(operation)?.steps;
  if (!steps) return null;
  return { migrationId: handoff.migrationId, sourceEpoch, steps };
}

const CLEAR = { clear: true } as const;

function recoveryRearmPatch(operation: Operation, intent: NonNullable<SchedulerHandoffState["sourceRecovery"]>, now: number): OperationPatch {
  const { attempt, history } = recoveryAttemptHistory(operation, now);
  return {
    status: "pending", startedAt: null, completedAt: null, steps: [],
    input: { ...operation.input, recoverSourceOnly: true }, schedulerHandoffReleased: false,
    schedulerHandoff: { ...operation.schedulerHandoff!, sourceRecovery: intent },
    attempts: Math.max(operation.attempts ?? 0, attempt), attemptHistory: history,
    error: CLEAR, expireAt: CLEAR, lastProgressAt: CLEAR,
    nextAttemptAt: operation.schedulerHandoff!.sourceRecovery ? now + retryBackoffMs(attempt) : CLEAR,
    waitingOn: CLEAR, rolledBack: CLEAR,
  };
}

function failedRecoveryAdmitted(operation: Operation): boolean {
  if (operation.status !== "failed") return false;
  if (operation.input.recoverSourceOnly === true) {
    return operation.rolledBack !== true && operation.schedulerHandoffReleased !== true && handoffAttemptEvidence(operation)?.steps !== undefined;
  }
  if (userActivationSourceRecoveryPending(operation)) return true;
  return typeof operation.error === "string" && (legacyHeldTargetCleanupPending(operation) || rollbackRecoveryPending(operation) ||
    /^reaped: (?:controller restarted mid-op|op exceeded \d+m running budget)/.test(operation.error) ||
    /gateway starting; retry shortly|rsync import port \d+ is already serving migrationId=/.test(operation.error));
}

export async function rearmOwnedLegacyMigration(input: {
  store: PlatformStateStore;
  operationId: string;
  now: number;
  admitted: (operation: Operation) => boolean;
}): Promise<boolean> {
  return input.store.transaction({ label: "legacy-migration-recovery.rearm" }, async (tx) => {
    const operation = await tx.journal.operations.get(input.operationId);
    if (!operation || operation.kind !== "migrate-user" || !operation.input ||
        !input.admitted(operation) || !recoverableLegacyScope(operation)) return false;
    if (operation.input.recoverSourceOnly === true && operation.schedulerHandoffReleased === true) return false;
    const { uid, fromGatewayId, toGatewayId } = operation.input as { uid: string; fromGatewayId: string; toGatewayId: string };
    const [owner, source, target] = await Promise.all([
      tx.users.records.get(uid),
      tx.gateways.assignments.get(fromGatewayId, uid),
      tx.gateways.assignments.get(toGatewayId, uid),
    ]);
    if (!ownsLegacySource(operation, owner, source, target !== null)) return false;
    const intent = recoveryIntent(operation, source!.epoch);
    if (!intent || operation.schedulerHandoff!.forwardRecovery && operation.schedulerHandoff!.forwardRecovery.sourceEpoch !== intent.sourceEpoch) return false;
    if (userActivationSourceRecoveryPending(operation)) {
      const root = await tx.gateways.roots.get(toGatewayId);
      if (!userActivationRecoveryTargetMatches({ operationId: operation.id, input: operation.input,
        openclaw: { activationLease: owner!.activationLease ?? undefined }, sourceEpoch: intent.sourceEpoch, targetRoot: root })) return false;
    }
    await tx.journal.operations.patch(operation.id, recoveryRearmPatch(operation, intent, input.now),
      { status: [operation.status], startedAt: operation.startedAt });
    return true;
  });
}

function preparationAwaitingTargetUnmount(operation: Operation & { cancellationRequestedAt?: number }): boolean {
  return [
    operation.kind === "migrate-user", operation.status === "failed",
    operation.input?.source !== "builder-activation-lease",
    operation.cutoverCommittedAt === undefined, operation.userMigrationV2 === undefined,
    operation.cancellationRequestedAt === undefined,
    operation.schedulerHandoff === undefined || operation.schedulerHandoffReleased === true,
    preSyncFailedWithUnconfirmedUnmount(operation.steps),
  ].every(Boolean);
}

type MigrationEndpoints = { uid: string; fromGatewayId: string; toGatewayId: string };

function migrationEndpoints(operation: Operation): MigrationEndpoints | null {
  const { uid, fromGatewayId, toGatewayId } = operation.input as Partial<Record<keyof MigrationEndpoints, unknown>>;
  if (typeof uid !== "string" || typeof fromGatewayId !== "string" || typeof toGatewayId !== "string") return null;
  return uid && fromGatewayId && toGatewayId && fromGatewayId !== toGatewayId ? { uid, fromGatewayId, toGatewayId } : null;
}

function preparationHeldAtSource(
  operationId: string,
  endpoints: MigrationEndpoints,
  owner: Stored<PlatformUserRecord>,
  source: Stored<GatewayAssignment> | null,
  target: Stored<GatewayAssignment> | null,
): boolean {
  const marker = readWorkspaceMigrationMarker({ migration: owner.fences.migration });
  return [
    marker?.operationId === operationId, marker?.state === "preparing", marker?.phase === "preparing",
    owner.gateway?.gatewayId === endpoints.fromGatewayId,
    owner.fences.restoreFence === undefined, owner.fences.sourceTransferFence === undefined,
    source?.uid === endpoints.uid, source?.state === "serving", target === null,
  ].every(Boolean);
}

async function targetRetired(tx: PlatformStateTransaction, gatewayId: string): Promise<boolean> {
  const root = await tx.gateways.roots.get(gatewayId);
  if (root === null) return true;
  const claim = root.retirementClaim as { operationId?: unknown } | null | undefined;
  if (root.desiredStatus !== "retired" || typeof claim?.operationId !== "string") return false;
  const retirement = await tx.journal.operations.get(claim.operationId);
  return retirement?.kind === RETIRE_GATEWAY_KIND && retirement.status === "succeeded" && retirement.input?.gatewayId === gatewayId;
}

async function releaseRetiredTargetPreparation(
  store: PlatformStateStore,
  operationId: string,
): Promise<{ uid: string; targetGatewayId: string } | null> {
  return store.transaction({ label: "legacy-migration-recovery.release-retired-target-preparation" }, async (tx) => {
    const operation = await tx.journal.operations.get(operationId);
    const endpoints = operation && preparationAwaitingTargetUnmount(operation) ? migrationEndpoints(operation) : null;
    if (!operation || !endpoints) return null;
    const { uid, fromGatewayId, toGatewayId } = endpoints;
    const [owner, source, target] = await Promise.all([
      tx.users.records.get(uid),
      tx.gateways.assignments.get(fromGatewayId, uid),
      tx.gateways.assignments.get(toGatewayId, uid),
    ]);
    if (!owner || !preparationHeldAtSource(operation.id, endpoints, owner, source, target) ||
        !await targetRetired(tx, toGatewayId)) return null;
    await tx.users.records.setFence(uid, "migration", CLEAR, owner.fences.migration ?? "absent");
    return { uid, targetGatewayId: toGatewayId };
  });
}

export async function recoverFailedLegacyMigrations(deps: { store: PlatformStateStore; log: (message: string) => void; now: () => number }): Promise<void> {
  const failed = await deps.store.journal.operations.listByStatus(["failed"]);
  for (const operation of failed) {
    try {
      const rearmed = await rearmOwnedLegacyMigration({ store: deps.store, operationId: operation.id, now: deps.now(), admitted: failedRecoveryAdmitted });
      if (rearmed) {
        deps.log(`[migration-recovery] queued native source recovery for ${operation.id}; assignment and marker remain held`);
        continue;
      }
      const released = preparationAwaitingTargetUnmount(operation) && await releaseRetiredTargetPreparation(deps.store, operation.id);
      if (released) {
        deps.log(`[migration-recovery] released ${operation.id}'s preparation marker for ${released.uid}: target ${released.targetGatewayId} retired before its unmount was confirmed`);
      }
    } catch (error) {
      deps.log(`[migration-recovery] ${operation.id} recovery admission failed: ${String(error)}`);
    }
  }
}
