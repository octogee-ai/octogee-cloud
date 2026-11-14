import { isDeepStrictEqual } from 'node:util';
import type { Operation } from '@octogee/shared/types/glm';
import type { PlatformUserRecord, GatewayRoot, GatewayRuntimeRestartFenceValue, OperationRecord, PlatformStateStore, PlatformStateTransaction, Stored, UntypedRecord } from '@octogee/core/platform-state';
import type { OperationContext } from '../operation-router.js';
import type { KubectlSubprocess } from '../fleet-ingress.js';
import { queuedSharedMigrationOwnsSourceInStore } from './queued-shared-migration.js';

type RecordValue = UntypedRecord;
interface Recovery { operationId: string; sourceSha: string; images: Record<string, string>; reauthorize?: RecordValue; supersede?: RecordValue }
export interface SharedPodRecoveryDeps { store: PlatformStateStore; namespace: string; sourceSha: string; runKubectl: KubectlSubprocess; now?: () => number; wait?: (ms: number) => Promise<void> }
type Deps = SharedPodRecoveryDeps;
function object(value: unknown): RecordValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}; }
function liveShared(root: GatewayRoot | null): root is Stored<GatewayRoot> {
  return root !== null && root.gatewayClass === 'shared' && ['running', 'draining'].includes(root.desiredStatus) && root.retirementClaim == null &&
    Number.isSafeInteger(root.liveRelease) && root.liveRelease! >= 1 && root.liveRelease === root.desiredRelease;
}
function restoreMatches(receipt: RecordValue, returned: RecordValue, gatewayId: string): boolean {
  const handoff = object(returned.schedulerHandoff); const input = object(returned.input);
  return [input.uid === receipt.uid, input.toGatewayId === gatewayId, input.fromGatewayId === receipt.fromGatewayId,
    receipt.fromGatewayId !== gatewayId, handoff.uid === receipt.uid, handoff.slug === receipt.slug,
    handoff.toGatewayId === gatewayId, handoff.fromGatewayId === receipt.fromGatewayId].every(Boolean);
}
function reauthorizationMatches(input: Recovery, receipt: RecordValue, status: unknown): boolean {
  return input.reauthorize === undefined || (status === 'pending' && isDeepStrictEqual(input.reauthorize, receipt) &&
    Number.isSafeInteger(receipt.claimStartedAt) && receipt.claimStartedAt > 0 &&
    Number.isSafeInteger(receipt.dispatchedAt) && receipt.dispatchedAt > 0);
}
function assertRecoveryBuild(op: Operation, input: RecordValue, sourceSha: string): void {
  if (op.kind !== 'restart-gateway' || typeof op.input.gatewayId !== 'string' ||
      typeof input.operationId !== 'string' || !input.operationId || input.operationId.includes('/') ||
      !/^[a-f0-9]{40}$/.test(input.sourceSha) || input.sourceSha !== sourceSha) throw new Error('restore recovery build identity is unavailable');
}
function assertRecoveryImages(images: RecordValue, sourceSha: string): void {
  for (const [name, repository] of [['gateway', 'octogee-gateway'], ['gateway-edge', 'gateway-edge']]) {
    const prefix = `us-central1-docker.pkg.dev/octogee/octogee/${repository}:${sourceSha.slice(0, 7)}`;
    if (typeof images[name!] !== 'string' || !images[name!].startsWith(prefix) ||
        !/^[a-z0-9._-]*@sha256:[a-f0-9]{64}$/.test(images[name!].slice(prefix.length))) throw new Error('restore recovery requires digest-addressed images from the deployed build');
  }
}
function assertRecoverySupersession(input: RecordValue, operationId: string): void {
  const supersede = object(input.supersede);
  if (input.supersede !== undefined && (typeof supersede.operationId !== 'string' ||
      !supersede.operationId || supersede.operationId.includes('/') || supersede.operationId === operationId)) throw new Error('restore recovery predecessor is invalid');
}
function recovery(op: Operation, sourceSha: string): Recovery {
  const input = object(op.input.restoreRecovery);
  assertRecoveryBuild(op, input, sourceSha);
  const images = object(input.images);
  assertRecoveryImages(images, sourceSha);
  assertRecoverySupersession(input, op.id);
  if (Object.keys(images).length !== 2) throw new Error('restore recovery image surface is invalid');
  return input as Recovery;
}

function claimMatches(current: OperationRecord | undefined, op: Operation): boolean {
  return current?.status === 'running' && current.startedAt === op.startedAt && current.cancellationRequestedAt === undefined &&
    isDeepStrictEqual(current.input, op.input);
}
function returnedAwaitsRestore(returned: RecordValue): boolean {
  return returned.kind === 'migrate-user' && ['pending', 'failed'].includes(returned.status) && returned.cancellationRequestedAt === undefined &&
    returned.cutoverCommittedAt > 0 && Number.isFinite(returned.cutoverCommittedAt);
}
function receiptMatches(receipt: RecordValue, fence: RecordValue, input: Recovery, gatewayId: string): boolean {
  return receipt.phase === 'dispatched' && isDeepStrictEqual(receipt, fence) && typeof receipt.uid === 'string' && Boolean(receipt.uid) &&
    receipt.operationId === input.operationId && receipt.gatewayId === gatewayId && Number.isSafeInteger(receipt.assignmentEpoch) &&
    typeof receipt.attemptId === 'string' && Boolean(receipt.attemptId.trim());
}
function restoreOwnerReady(user: Stored<PlatformUserRecord> | undefined): boolean {
  return user?.openclaw.status === 'complete' && user.fences.sourceTransferFence === undefined;
}
async function assertRestoreAssignment(tx: PlatformStateTransaction, gatewayId: string, receipt: RecordValue): Promise<void> {
  const assignment = await tx.gateways.assignments.get(gatewayId, receipt.uid);
  if (!assignment || ![assignment.uid === receipt.uid, assignment.slug === receipt.slug, assignment.gatewayId === gatewayId,
    assignment.epoch === receipt.assignmentEpoch, assignment.state === "serving"].every(Boolean)) {
    throw new Error('restore recovery assignment changed');
  }
}
async function authority(tx: PlatformStateTransaction, op: Operation, input: Recovery): Promise<Stored<GatewayRoot>> {
  const gatewayId = op.input.gatewayId as string;
  const [root, operations, holders, active] = await Promise.all([
    tx.gateways.roots.get(gatewayId), tx.journal.operations.getMany([op.id, input.operationId]),
    tx.users.records.listGatewayFenceHolders(gatewayId), tx.journal.operations.listByStatus(['running', 'pending']),
  ]);
  const returned: RecordValue = { ...operations.get(input.operationId) };
  const receipt = object(returned.restoreAttempt);
  const user = holders.assigned.find(row => row.uid === receipt.uid);
  const exact = [
    holders.sourceTransferSource.length === 0, holders.sourceTransferTarget.length === 0,
    claimMatches(operations.get(op.id), op), returnedAwaitsRestore(returned),
    receiptMatches(receipt, object(user?.fences.restoreFence), input, gatewayId),
    restoreMatches(receipt, returned, gatewayId), restoreOwnerReady(user),
  ].every(Boolean);
  if (!liveShared(root) || !exact) throw new Error('paired post-cutover restore authority is unavailable');
  if (!reauthorizationMatches(input, receipt, returned.status)) throw new Error('restore reauthorization requires an unchanged intent and a pending native return');
  await assertRestoreAssignment(tx, gatewayId, receipt);
  for (const row of holders.assigned) {
    if (row.uid !== receipt.uid && (row.fences.restoreFence !== undefined || row.fences.sourceTransferFence !== undefined)) throw new Error('another user runtime outcome is unresolved');
  }
  await assertNoCompetingMigrations(tx, active, { operationId: input.operationId, gatewayId });
  return root;
}

async function assertNoCompetingMigrations(tx: PlatformStateTransaction, active: readonly Stored<OperationRecord>[],
  scope: { operationId: string; gatewayId: string }): Promise<void> {
  for (const row of active) {
    const move: RecordValue = { ...row };
    if (!competingMigration(row.id, move, scope.operationId, scope.gatewayId)) continue;
    if (move.input?.fromGatewayId !== scope.gatewayId || move.schedulerHandoffReleased !== true ||
        !Number.isSafeInteger(move.schedulerHandoffReleasedAt) || move.schedulerHandoffReleasedAt <= 0 ||
        !await queuedSharedMigrationOwnsSourceInStore(tx, move, row.id) ||
        move.schedulerHandoffReleasedAt < move.attemptHistory.at(-1).completedAt) {
      throw new Error('another migration is active on the restore target');
    }
  }
}
function pristineQueuedMigration(row: RecordValue): boolean {
  const untouched = ['firstStartedAt', 'lastProgressAt', 'lastResumedAt', 'nextAttemptAt', 'error', 'rolledBack', 'output',
    'userMigrationV2', 'sourceTransferExecution', 'schedulerHandoff', 'schedulerHandoffReleased',
    'schedulerHandoffReleasedAt', 'schedulerHandoffLost', 'cutoverCommittedAt', 'restoreAttempt', 'cancellationRequestedAt'];
  const input = object(row.input);
  const identity = [input.uid, input.fromGatewayId, input.toGatewayId].every(value => typeof value === 'string' && value.length > 0);
  return row.status === 'pending' && row.startedAt === null && row.completedAt === null &&
    Number.isSafeInteger(row.createdAt) && row.createdAt > 0 && identity && input.fromGatewayId !== input.toGatewayId &&
    Array.isArray(row.steps) && row.steps.length === 0 &&
    [row.attempts, row.resumeCount].every(value => value === undefined || value === 0) &&
    (row.attemptHistory === undefined || (Array.isArray(row.attemptHistory) && row.attemptHistory.length === 0)) &&
    untouched.every(key => row[key] === undefined);
}
function competingMigration(id: string, row: RecordValue, operationId: string, gatewayId: string): boolean {
  const input = object(row.input);
  return id !== operationId && row.kind === 'migrate-user' && [input.fromGatewayId, input.toGatewayId].includes(gatewayId) &&
    !pristineQueuedMigration(row);
}

async function json(deps: Pick<Deps, 'namespace' | 'runKubectl'>, args: string[]): Promise<RecordValue> {
  const result = await deps.runKubectl(['-n', deps.namespace, ...args, '-o', 'json'], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error('restore recovery Kubernetes outcome is unresolved');
  return JSON.parse(result.stdout);
}
function validatePod(pod: RecordValue, gatewayId: string): void {
  const metadata = object(pod.metadata); const spec = object(pod.spec); const status = object(pod.status);
  const containers = spec.containers;
  if (metadata.deletionTimestamp || status.phase !== 'Running' || !metadata.uid || !metadata.resourceVersion ||
      object(metadata.labels)['gateway-instance'] !== gatewayId || !Array.isArray(containers) || containers.length !== 2 ||
      !retainsSharedStorage(spec)) throw new Error('restore recovery requires the existing Shared pod storage');
}
function retainsSharedStorage(spec: RecordValue): boolean {
  return spec.volumes?.some((volume: RecordValue) => volume.name === 'data' && volume.emptyDir) &&
    ['gateway', 'gateway-edge'].every(name => spec.containers.find((container: RecordValue) => container.name === name)?.volumeMounts?.some(
      (mount: RecordValue) => mount.name === 'data' && mount.mountPath === '/home/node' && !mount.subPath));
}
export function recoveredPodReady(pod: RecordValue, saved: RecordValue, images: Recovery['images']): boolean {
  return pod.metadata?.uid === saved.podUid && !pod.metadata?.deletionTimestamp &&
    pod.status?.conditions?.some((condition: RecordValue) => condition.type === 'Ready' && condition.status === 'True') &&
    Object.entries(images).every(([name, image]) => pod.spec?.containers?.find((container: RecordValue) => container.name === name)?.image === image &&
      pod.status?.containerStatuses?.some((status: RecordValue) => status.name === name && status.ready === true &&
        status.imageID?.endsWith(`@${image.split('@')[1]}`)));
}

async function existingOwnedPod(deps: Pick<Deps, 'namespace' | 'runKubectl'>, gatewayId: string): Promise<RecordValue> {
  const pods = (await json(deps, ['get', 'pods', '-l', `gateway-instance=${gatewayId}`])).items;
  if (!Array.isArray(pods) || pods.length !== 1) throw new Error('restore recovery requires one existing pod');
  const pod = pods[0]; validatePod(pod, gatewayId);
  const replicaSet = pod.metadata.ownerReferences?.find((owner: RecordValue) => owner.controller && owner.kind === 'ReplicaSet');
  if (!replicaSet) throw new Error('restore recovery pod owner is unavailable');
  const [rs, deployment] = await Promise.all([
    json(deps, ['get', 'replicaset', replicaSet.name]), json(deps, ['get', 'deployment', `octogee-gateway-${gatewayId}`]),
  ]);
  if (rs.metadata?.uid !== replicaSet.uid || !rs.metadata?.ownerReferences?.some((owner: RecordValue) => owner.controller && owner.kind === 'Deployment' &&
      owner.uid === deployment.metadata?.uid) || deployment.metadata?.deletionTimestamp) throw new Error('restore recovery pod deployment changed');
  return pod;
}
function recoveryPredecessorOperationMatches(previous: RecordValue, captured: RecordValue, gatewayId: unknown): boolean {
  const statusMatches = captured.status === 'pending' ?
    previous.status === 'pending' && previous.startedAt === null && previous.completedAt === null && captured.completedAt === null &&
      typeof previous.error === 'string' && Boolean(previous.error) : previous.status === 'failed' && previous.completedAt > 0 && previous.completedAt === captured.completedAt;
  return previous.kind === 'restart-gateway' && statusMatches && previous.cancellationRequestedAt === undefined && previous.restoreRuntimeRecovery === undefined &&
    isDeepStrictEqual(previous.input, captured.input) && previous.input?.gatewayId === gatewayId;
}
function recoveryPredecessorFenceMatches(params: {
  fence: RecordValue;
  captured: RecordValue;
  gatewayId: unknown;
  operationId: string;
  pod: RecordValue;
}): boolean {
  const { fence, captured, gatewayId, operationId, pod } = params;
  const target = object(fence.target);
  return isDeepStrictEqual(fence, captured.fence) && fence.kind === 'restore-recovery' && fence.attemptId === captured.operationId &&
    fence.gatewayId === gatewayId && fence.phase === 'dispatched' && target.podUid === pod.metadata.uid &&
    target.podName === pod.metadata.name && target.restoreOperationId === operationId;
}
async function assertRecoveryPredecessor(params: {
  tx: PlatformStateTransaction;
  op: Operation;
  input: Recovery;
  existing: unknown;
  pod: RecordValue;
}): Promise<void> {
  const { tx, op, input, existing, pod } = params;
  const captured = input.supersede!;
  if (input.reauthorize === undefined) throw new Error('failed restore recovery requires explicit reauthorization');
  const previous: RecordValue = { ...await tx.journal.operations.get(captured.operationId) };
  const fence = object(existing); const target = object(fence.target);
  if (!recoveryPredecessorOperationMatches(previous, captured, op.input.gatewayId) ||
      !recoveryPredecessorFenceMatches({ fence, captured, gatewayId: op.input.gatewayId, operationId: input.operationId, pod })) throw new Error('failed restore recovery predecessor changed');
  const prior = recovery(previous as Operation, previous.input.restoreRecovery?.sourceSha);
  if (prior.operationId !== input.operationId || !isDeepStrictEqual(prior.images, target.images) ||
      !isDeepStrictEqual(prior.reauthorize, input.reauthorize)) throw new Error('failed restore recovery custody changed');
  imagePatch(pod, fence, prior.images);
}
async function reserveRecovery(deps: Deps, op: Operation, input: Recovery, pod: RecordValue): Promise<RecordValue> {
  const gatewayId = op.input.gatewayId as string;
  return deps.store.transaction({ label: 'shared-restore-runtime.reserve' }, async tx => {
    const root = await authority(tx, op, input);
    const existing: RecordValue | undefined = root.runtimeRestartFence;
    if (input.supersede && existing?.attemptId !== op.id) {
      await assertRecoveryPredecessor({ tx, op, input, existing, pod });
    } else if (existing !== undefined) {
      if (existing.kind !== 'restore-recovery' || existing.attemptId !== op.id || existing.target?.podUid !== pod.metadata.uid ||
          existing.target?.restoreOperationId !== input.operationId || !isDeepStrictEqual(existing.target?.images, input.images)) throw new Error('another runtime restart outcome is unresolved');
      return existing;
    }
    const fence: GatewayRuntimeRestartFenceValue = { kind: 'restore-recovery', attemptId: op.id, auditId: op.id, gatewayId, startedAt: Date.now(), phase: 'reserved',
      target: { podName: pod.metadata.name, podUid: pod.metadata.uid, restoreOperationId: input.operationId, images: input.images,
        originalImages: Object.fromEntries(pod.spec.containers.map((container: RecordValue) => [container.name, container.image])) } };
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(gatewayId, root.runtimeRestartFence ?? null, fence);
    return fence;
  });
}
function imagePatch(current: RecordValue, saved: RecordValue, images: Recovery['images']) {
  const patch = [{ op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion }];
  current.spec.containers.forEach((container: RecordValue, index: number) => {
    if (![saved.target.originalImages[container.name], images[container.name]].includes(container.image)) throw new Error('restore recovery image changed outside its claim');
    patch.push({ op: 'test', path: `/spec/containers/${index}/image`, value: container.image });
    patch.push({ op: 'replace', path: `/spec/containers/${index}/image`, value: images[container.name] });
  });
  return patch;
}
async function waitForRecovery(deps: Deps, ctx: OperationContext, saved: RecordValue, input: Recovery): Promise<void> {
  const now = deps.now ?? Date.now; const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))); const deadline = now() + 240_000;
  while (now() < deadline) {
    await ctx.assertActiveClaim!();
    const observed = await json(deps, ['get', 'pod', saved.target.podName]);
    if (observed.metadata?.uid !== saved.target.podUid || observed.metadata?.deletionTimestamp) throw new Error('restore recovery pod was replaced; outcome remains fenced');
    if (recoveredPodReady(observed, saved.target, input.images)) return;
    await wait(1000);
  }
  throw new Error('restore recovery images are not ready; outcome remains fenced');
}
function completedRecovery(completed: RecordValue, gatewayId: string, input: Recovery): boolean {
  return completed.completedAt > 0 && completed.gatewayId === gatewayId && completed.restoreOperationId === input.operationId &&
    completed.sourceSha === input.sourceSha && isDeepStrictEqual(completed.images, input.images) &&
    isDeepStrictEqual(completed.previousRestoreAttempt, input.reauthorize);
}
async function reauthorizeRestore(tx: PlatformStateTransaction, op: Operation, input: Recovery, now: number): Promise<void> {
  if (!input.reauthorize) return;
  if (now < input.reauthorize.claimStartedAt) throw new Error('restore reauthorization clock precedes the retained intent');
  const intent: RecordValue = { ...input.reauthorize, claimStartedAt: now, dispatchClaimStartedAt: now, dispatchedAt: now, reauthorizedBy: op.id };
  await tx.users.records.setFence(intent.uid, 'restoreFence', intent);
  await tx.journal.operations.patch(input.operationId, { restoreAttempt: intent });
}
export async function recoverSharedRestoreRuntime(deps: Deps, op: Operation, ctx: OperationContext): Promise<void> {
  const input = recovery(op, deps.sourceSha); const gatewayId = op.input.gatewayId as string;
  if (!ctx.assertActiveClaim) throw new Error('restore recovery operation claim is unavailable');
  await ctx.assertActiveClaim();
  const completed = object((await deps.store.journal.operations.get(op.id))?.restoreRuntimeRecovery);
  if (completedRecovery(completed, gatewayId, input)) return;
  const pod = await existingOwnedPod(deps, gatewayId);
  let saved = await reserveRecovery(deps, op, input, pod);
  const update = async (next: RecordValue | null) => {
    await ctx.assertActiveClaim!();
    await deps.store.transaction({ label: 'shared-restore-runtime.update' }, async tx => {
      const root = await authority(tx, op, input);
      const fence = root.runtimeRestartFence;
      if (fence === undefined || !isDeepStrictEqual(fence, saved)) throw new Error('restore recovery restart fence changed');
      await tx.gateways.roots.compareAndSetRuntimeRestartFence(gatewayId, fence, next as GatewayRuntimeRestartFenceValue | null);
      if (!next) {
        const now = Date.now();
        await reauthorizeRestore(tx, op, input, now);
        await tx.journal.operations.patch(op.id, { restoreRuntimeRecovery: {
          gatewayId, restoreOperationId: input.operationId, sourceSha: input.sourceSha, images: input.images,
          podUid: saved.target.podUid, completedAt: now,
          ...(input.reauthorize ? { previousRestoreAttempt: input.reauthorize } : {}),
        } });
      }
    });
    if (next) saved = next;
  };
  const current = await json(deps, ['get', 'pod', saved.target.podName]); validatePod(current, gatewayId);
  if (current.metadata.uid !== saved.target.podUid) throw new Error('restore recovery refuses replacement pod storage');
  const patch = imagePatch(current, saved, input.images);
  if (!recoveredPodReady(current, saved.target, input.images)) {
    await update({ ...saved, phase: 'dispatched' });
    if (Object.entries(input.images).some(([name, image]) => current.spec.containers.find((container: RecordValue) => container.name === name)?.image !== image)) {
      await json(deps, ['patch', 'pod', current.metadata.name, '--type=json', '-p', JSON.stringify(patch)]);
    }
  }
  await waitForRecovery(deps, ctx, saved, input);
  await update(null);
}

export { existingOwnedPod, imagePatch, json, assertRecoveryImages };
