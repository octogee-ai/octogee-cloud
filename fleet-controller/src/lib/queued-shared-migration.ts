import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { GATEWAY_UNREACHABLE_AFTER_MS } from '@octogee/shared/types/fleet-controller';
import { hasFreshReadyKubernetesObservation, type AssignmentDoc, type GatewayRuntimeDoc } from '@octogee/shared/types/gateway-releases';
import { readWorkspaceMigrationMarker } from '@octogee/shared/types/workspace-migration';
import { isolatedRuntimeMutationFenced } from '@octogee/core/gateway-retirement-claim';
import type { PlatformUserRecord, PlatformStateRepositories, PlatformStateStore, OperationRecord, Stored, UntypedRecord } from '@octogee/core/platform-state';
import { MAX_OPERATION_ATTEMPT_HISTORY } from '../operation-retry.js';

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sourcePodSelectionFailure(error: unknown, gatewayId: string): boolean {
  const prefix = `expected exactly one ready pod for transport=${gatewayId}; found `;
  if (typeof error !== 'string' || !error.startsWith(prefix)) return false;
  const cardinality = error.slice(prefix.length), count = Number(cardinality);
  return /^(0|[1-9]\d*)$/.test(cardinality) && Number.isSafeInteger(count) && count !== 1;
}

function untouchedTransportHistory(row: UntypedRecord): boolean {
  const history = row.attemptHistory;
  if (!positiveInteger(row.attempts) || !Array.isArray(history) || history.length !== Math.min(row.attempts, MAX_OPERATION_ATTEMPT_HISTORY)) return false;
  const firstRetainedAttempt = row.attempts - history.length + 1;
  const error = `expected exactly one ready pod for transport=${row.input.fromGatewayId}; found 0`;
  return history.every((attempt, index) => attempt?.attempt === firstRetainedAttempt + index &&
    attempt.classification === 'transient' && sourcePodSelectionFailure(attempt.error, row.input.fromGatewayId) &&
    (index < history.length - 1 || attempt.error === error) &&
    positiveInteger(attempt.startedAt) && positiveInteger(attempt.completedAt) && attempt.completedAt >= attempt.startedAt &&
    Array.isArray(attempt.steps) && attempt.steps.length === 1 &&
    attempt.steps[0]?.name === 'keys-sync-state' && attempt.steps[0].status === 'failed' && attempt.steps[0].error === attempt.error);
}

function handoffMatches(row: UntypedRecord, id: string): boolean {
  const input = row.input, handoff = row.schedulerHandoff;
  const identity = readSchedulerMigrationIdentity(id, handoff?.migrationId);
  return handoff && identity !== null && handoff.uid === input.uid && handoff.slug === input.userSlug &&
    handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId &&
    identity.attempt === row.attempts &&
    identity.claimStartedAt === row.attemptHistory?.at(-1)?.startedAt &&
    ['stageAfterCutover', 'stagedAt', 'sourceRecovery'].every(key => handoff[key] === undefined);
}

function queuedSharedScope(row: UntypedRecord): boolean {
  const input = row.input;
  return row.kind === 'migrate-user' && input &&
    ['uid', 'userSlug', 'fromGatewayId', 'toGatewayId'].every(key => typeof input[key] === 'string' && input[key].length > 0 && !input[key].includes('/')) &&
    input.fromGatewayId.startsWith('shared-') && input.toGatewayId.startsWith('shared-') && input.fromGatewayId !== input.toGatewayId &&
    input.sourceTransferMode === undefined && input.recoverSourceOnly === undefined;
}

function unclaimedRetry(row: UntypedRecord): boolean {
  const untouched = ['userMigrationV2', 'sourceTransferExecution', 'schedulerHandoffLost', 'cutoverCommittedAt',
    'restoreAttempt', 'cancellationRequestedAt', 'rolledBack', 'lastResumedAt'];
  return row.status === 'pending' && row.startedAt === null && row.completedAt === null &&
    (row.resumeCount === undefined || row.resumeCount === 0) && untouched.every(key => row[key] === undefined) &&
    Array.isArray(row.steps) && row.steps.length === 0 && row.output === undefined;
}

function queuedSharedMigrationBeforeTransport(row: UntypedRecord, id: string): boolean {
  return queuedSharedScope(row) && unclaimedRetry(row) && handoffMatches(row, id) && untouchedTransportHistory(row);
}

function userOwnerMatches(row: UntypedRecord, id: string, owner: Stored<PlatformUserRecord> | null, requirePreparation: boolean): boolean {
  if (!owner) return false;
  const marker = readWorkspaceMigrationMarker({ migration: owner.fences.migration });
  const preparing = marker?.operationId === id && marker.state === 'preparing' && marker.phase === 'preparing';
  return !isolatedRuntimeMutationFenced(owner) && owner.gateway?.gatewayId === row.input.fromGatewayId &&
    ['complete', 'provisioning'].includes(owner.openclaw.status ?? '') &&
    (preparing || !requirePreparation && owner.fences.migration === undefined && row.attemptHistory.length === row.attempts);
}

function sourceAssignmentMatches(row: UntypedRecord, id: string, assignment: UntypedRecord | AssignmentDoc | null | undefined): boolean {
  if (!assignment) return false;
  return assignment.uid === row.input.uid && assignment.slug === row.input.userSlug && assignment.gatewayId === row.input.fromGatewayId &&
    assignment.state === 'serving' && Number.isSafeInteger(assignment.epoch) && assignment.epoch >= 0 &&
    assignment.updatedByOperationId !== id &&
    (assignment.updatedByOperationId == null || typeof assignment.updatedByOperationId === 'string' && assignment.updatedByOperationId.length > 0);
}

type SharedMigrationState = Pick<PlatformStateRepositories, 'users' | 'gateways'>;

async function verifyQueuedSharedSourceCustody(
  state: SharedMigrationState, row: UntypedRecord, id: string, requirePreparation: boolean, assignedBefore?: number,
): Promise<boolean> {
  if (!queuedSharedMigrationBeforeTransport(row, id)) return false;
  const { uid, fromGatewayId, toGatewayId } = row.input;
  const [owner, source, target] = await Promise.all([
    state.users.records.get(uid), state.gateways.assignments.get(fromGatewayId, uid), state.gateways.assignments.get(toGatewayId, uid),
  ]);
  return target === null && (assignedBefore === undefined || source !== null && source.updatedAt <= assignedBefore) &&
    userOwnerMatches(row, id, owner, requirePreparation) && sourceAssignmentMatches(row, id, source);
}

export function queuedSharedMigrationOwnsSourceInStore(
  state: SharedMigrationState, row: UntypedRecord, id: string,
): Promise<boolean> {
  return verifyQueuedSharedSourceCustody(state, row, id, true);
}

export function queuedSharedMigrationNeverTouchedDestinationInStore(
  state: SharedMigrationState, row: UntypedRecord, id: string,
): Promise<boolean> {
  return verifyQueuedSharedSourceCustody(state, row, id, false);
}

type SharedMountObservation = Pick<GatewayRuntimeDoc, 'gatewayId' | 'kubernetes'> & {
  heartbeat: { status: string; mountedCustomers: readonly string[]; lastHeartbeatAt: number | null };
};

export function sharedSourceRemountedAfterFailure(row: UntypedRecord, runtime: SharedMountObservation, now: number): boolean {
  if (!(row.nextAttemptAt > now) || row.input?.fromGatewayId !== runtime.gatewayId ||
      row.schedulerHandoff?.forwardRecovery !== undefined || !queuedSharedMigrationBeforeTransport(row, row.id)) return false;
  const failedAt = row.attemptHistory.at(-1).completedAt;
  const { heartbeat, kubernetes } = runtime;
  return kubernetes?.readyPods === 1 && kubernetes.observedAt > failedAt &&
    hasFreshReadyKubernetesObservation(runtime, now, GATEWAY_UNREACHABLE_AFTER_MS) &&
    heartbeat.status === 'ready' && heartbeat.lastHeartbeatAt !== null && heartbeat.lastHeartbeatAt > failedAt &&
    heartbeat.lastHeartbeatAt <= now && now - heartbeat.lastHeartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS &&
    heartbeat.mountedCustomers.includes(row.input.userSlug);
}

export function rearmRemountedSharedSource(store: PlatformStateStore, listed: Stored<OperationRecord>, now: number) {
  return store.transaction({ label: 'migration.rearm-remounted-shared-source' }, async tx => {
    const row = await tx.journal.operations.get(listed.id);
    if (!row || row.revision !== listed.revision || typeof row.input.fromGatewayId !== "string") return null;
    const runtime = await tx.fleetRegistry.get(row.input.fromGatewayId);
    if (!runtime || !sharedSourceRemountedAfterFailure(row, runtime, now) ||
        !await verifyQueuedSharedSourceCustody(tx, row, row.id, false, row.attemptHistory!.at(-1)!.startedAt)) return null;
    await tx.journal.operations.patch(row.id, { nextAttemptAt: { clear: true } }, { revision: row.revision });
    return { ...row, nextAttemptAt: null };
  });
}
