import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import type { AssignmentDoc } from '@octogee/shared/types/gateway-releases';
import { readWorkspaceMigrationMarker } from '@octogee/shared/types/workspace-migration';
import { isolatedRuntimeMutationFenced } from '@octogee/core/gateway-retirement-claim';
import type { PlatformUserRecord, PlatformStateRepositories, Stored, UntypedRecord } from '@octogee/core/platform-state';
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

function userOwnerMatches(row: UntypedRecord, id: string, owner: Stored<PlatformUserRecord> | null): boolean {
  if (!owner) return false;
  const marker = readWorkspaceMigrationMarker({ migration: owner.fences.migration });
  return !isolatedRuntimeMutationFenced(owner) && owner.gateway?.gatewayId === row.input.fromGatewayId &&
    ['complete', 'provisioning'].includes(owner.openclaw.status ?? '') && marker?.operationId === id && marker.state === 'preparing' && marker.phase === 'preparing';
}

function sourceAssignmentMatches(row: UntypedRecord, id: string, assignment: UntypedRecord | AssignmentDoc | null | undefined): boolean {
  if (!assignment) return false;
  return assignment.uid === row.input.uid && assignment.slug === row.input.userSlug && assignment.gatewayId === row.input.fromGatewayId &&
    assignment.state === 'serving' && Number.isSafeInteger(assignment.epoch) && assignment.epoch >= 0 &&
    assignment.updatedByOperationId !== id &&
    (assignment.updatedByOperationId == null || typeof assignment.updatedByOperationId === 'string' && assignment.updatedByOperationId.length > 0);
}

export async function queuedSharedMigrationOwnsSourceInStore(
  state: Pick<PlatformStateRepositories, 'users' | 'gateways'>, row: UntypedRecord, id: string,
): Promise<boolean> {
  if (!queuedSharedMigrationBeforeTransport(row, id)) return false;
  const { uid, fromGatewayId, toGatewayId } = row.input;
  const [owner, source, target] = await Promise.all([
    state.users.records.get(uid), state.gateways.assignments.get(fromGatewayId, uid), state.gateways.assignments.get(toGatewayId, uid),
  ]);
  return target === null && userOwnerMatches(row, id, owner) && sourceAssignmentMatches(row, id, source);
}
