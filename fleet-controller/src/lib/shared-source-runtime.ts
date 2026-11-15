import { assertSourceRecoveryDiscovery } from './shared-source-discovery.js';
import { managementHealthDriverSource } from './runtime-restart-driver.js';
import { isDeepStrictEqual } from 'node:util';
import type { Operation } from '@octogee/shared/types/glm';
import { assertSharedSourceRecoveryUnchanged, assertSharedSourceRecoveryPredecessor, readSharedSourceRecoveryAuthority, type SharedSourceRecoveryAuthority, type SharedSourceRecoverySupersession } from '@octogee/core/shared-source-recovery';
import type { GatewayRoot, GatewayRuntimeRestartFenceValue, PlatformStateTransaction, Stored, UntypedRecord } from '@octogee/core/platform-state';
import type { OperationContext } from '../operation-router.js';
import { assertRecoveryImages, existingOwnedPod, imagePatch, json, recoveredPodReady, type SharedPodRecoveryDeps } from './shared-restore-runtime.js';
import { captureSourceRecoveryWorkload, pinSourceRecoveryImages, resumeSourceRecoveryWorkload, type SourceRecoveryWorkload } from './shared-source-images.js';
import { recordRecoveredGatewayReleaseInStore } from '@octogee/core/gateway-release-append';
import { isReleasePayload, type ReleasePayload } from '@octogee/shared/types/gateway-releases';

type Row = UntypedRecord;
type Deps = SharedPodRecoveryDeps;
interface SourceRecovery extends SharedSourceRecoveryAuthority { sourceSha: string; images: Record<string, string>; payload?: ReleasePayload; supersede?: SharedSourceRecoverySupersession }
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function sourceRecovery(op: Operation, deployedSha: string): SourceRecovery {
  const input = object(op.input.sourceRecovery);
  if (op.kind !== 'restart-gateway' || typeof op.input.gatewayId !== 'string' || !op.input.gatewayId || op.input.gatewayId.includes('/') ||
    op.input.restoreRecovery !== undefined || input.sourceSha !== deployedSha || !/^[a-f0-9]{40}$/.test(input.sourceSha)) {
    throw new Error('source recovery build identity is unavailable');
  }
  assertRecoveryImages(object(input.images), deployedSha);
  if (Object.keys(object(input.images)).length !== 2) throw new Error('source recovery image surface is invalid');
  if (input.postgresAgentStores && (!isReleasePayload(input.payload) ||
      input.images.gateway !== `${input.payload.imageRepository}:${input.payload.imageTag}` ||
      input.images['gateway-edge'] !== `${input.payload.gatewayEdgeImage?.imageRepository}:${input.payload.gatewayEdgeImage?.imageTag}`)) {
    throw new Error('PostgreSQL source recovery requires its immutable release payload');
  }
  return input as SourceRecovery;
}
async function authority(tx: PlatformStateTransaction, op: Operation, input: SourceRecovery): Promise<Stored<GatewayRoot>> {
  const gatewayId = op.input.gatewayId as string;
  const [current, root, captured] = await Promise.all([
    tx.journal.operations.get(op.id), tx.gateways.roots.get(gatewayId),
    readSharedSourceRecoveryAuthority(tx, gatewayId, op.id, input.supersede?.operationId),
  ]);
  if (current?.status !== 'running' || current.startedAt !== op.startedAt || current.cancellationRequestedAt !== undefined ||
    !isDeepStrictEqual(current.input, op.input)) throw new Error('source recovery operation claim changed');
  assertSharedSourceRecoveryUnchanged(captured, input);
  if (root === null) throw new Error('source recovery gateway authority is unavailable');
  return root;
}
function ownedFence(root: Stored<GatewayRoot>, op: Operation, input: SourceRecovery, pod: Row): GatewayRuntimeRestartFenceValue {
  const fence = root.runtimeRestartFence;
  if (fence === undefined) throw new Error('source recovery runtime fence changed');
  assertOwnedFence(fence, op, input, pod);
  return fence;
}
function expectedAgents(input: SourceRecovery): Row[] {
  return input.assignments.map(({ uid, slug, agentId, assignmentEpoch }) => ({ uid, slug, agentId, assignmentEpoch }));
}
function assertOwnedFence(fence: Row, op: Operation, input: SourceRecovery, pod: Row): void {
  const target = object(fence.target), doctor = object(fence.doctor);
  if (![fence.kind === 'source-recovery', fence.attemptId === op.id, fence.auditId === op.id,
    fence.gatewayId === op.input.gatewayId, ['reserved', 'dispatched'].includes(fence.phase), doctor.requestId === op.id,
    target.podUid === pod.metadata.uid, target.podName === pod.metadata.name, target.sourceSha === input.sourceSha,
    isDeepStrictEqual(target.images, input.images), isDeepStrictEqual(target.agents, expectedAgents(input))].every(Boolean)) {
    throw new Error('source recovery runtime fence changed');
  }
  if (input.postgresAgentStores && (!isDeepStrictEqual(target.postgresAgentStores, input.postgresAgentStores) || !target.workload)) {
    throw new Error('source recovery PostgreSQL workload custody changed');
  }
  if (target.schedulerStateRecovery !== input.schedulerStateRecovery) throw new Error('source recovery scheduler custody changed');
}
async function reserve(deps: Deps, op: Operation, input: SourceRecovery, pod: Row, workload?: SourceRecoveryWorkload): Promise<void> {
  await deps.store.transaction({ label: 'shared-source-runtime.reserve' }, async tx => {
    const root = await authority(tx, op, input);
    const existing = root.runtimeRestartFence;
    if (existing !== undefined) {
      if (existing.attemptId === op.id) { assertOwnedFence(existing, op, input, pod); return; }
      await transferPredecessor({ deps, tx, op, input, pod, root, workload }); return;
    }
    if (input.supersede) throw new Error('captured source recovery predecessor fence is absent');
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(root.gatewayId, null, newFence(deps, op, input, pod, workload));
  });
}
function newFence(deps: Deps, op: Operation, input: SourceRecovery, pod: Row, workload?: SourceRecoveryWorkload): GatewayRuntimeRestartFenceValue {
  if (input.postgresAgentStores && !workload) throw new Error('PostgreSQL source recovery workload is unavailable');
  return { kind: 'source-recovery', attemptId: op.id, auditId: op.id, gatewayId: op.input.gatewayId as string,
      startedAt: (deps.now ?? Date.now)(), phase: 'reserved', doctor: { requestId: op.id },
      target: { podName: pod.metadata.name, podUid: pod.metadata.uid, sourceSha: input.sourceSha, images: input.images,
        originalImages: Object.fromEntries(pod.spec.containers.map((container: Row) => [container.name, container.image])),
        agents: expectedAgents(input),
        schedulerStateRecovery: input.schedulerStateRecovery,
        ...(input.postgresAgentStores ? { postgresAgentStores: input.postgresAgentStores, workload } : {}) } };
}
async function transferPredecessor(request: {
  deps: Deps; tx: PlatformStateTransaction; op: Operation; input: SourceRecovery; pod: Row; root: Stored<GatewayRoot>; workload?: SourceRecoveryWorkload;
}): Promise<void> {
  const { deps, tx, op, input, pod, root } = request;
  const supersede = input.supersede, predecessorFence = root.runtimeRestartFence;
  if (!supersede || supersede.operationId === op.id || predecessorFence === undefined) throw new Error('source recovery predecessor is unavailable');
  const prior = await tx.journal.operations.get(supersede.operationId);
  const captured = assertSharedSourceRecoveryPredecessor({ gatewayId: root.gatewayId, operationId: supersede.operationId,
    row: object(prior), fence: predecessorFence, source: input });
  if (!isDeepStrictEqual(captured, supersede)) throw new Error('source recovery predecessor changed');
  const old = object(supersede.input.sourceRecovery);
  assertRecoveryImages(object(old.images), old.sourceSha);
  assertOwnedFence(supersede.fence, { ...op, id: supersede.operationId, input: supersede.input }, old as SourceRecovery, pod);
  if (input.postgresAgentStores && !isDeepStrictEqual(request.workload, supersede.fence.target?.workload)) {
    throw new Error('source recovery predecessor workload changed');
  }
  assertPredecessorPodImages(pod, old.images);
  await tx.journal.operations.patch(supersede.operationId, { cancellationRequestedAt: (deps.now ?? Date.now)(), sourceRecoverySupersededBy: op.id });
  await tx.gateways.roots.compareAndSetRuntimeRestartFence(root.gatewayId, predecessorFence, newFence(deps, op, input, pod, request.workload));
}
function assertPredecessorPodImages(pod: Row, oldImages: Row): void {
  for (const [name, image] of Object.entries(oldImages)) {
    const spec = pod.spec?.containers?.find((c: Row) => c.name === name), status = pod.status?.containerStatuses?.find((c: Row) => c.name === name);
    if (spec?.image !== image || typeof status?.imageID !== 'string' ||
      !status.imageID.endsWith(`@${String(image).split('@')[1]}`)) throw new Error('source recovery predecessor Pod image changed');
  }
}
async function dispatch(deps: Deps, op: Operation, input: SourceRecovery, pod: Row): Promise<Row> {
  return deps.store.transaction({ label: 'shared-source-runtime.dispatch' }, async tx => {
    const root = await authority(tx, op, input), fence = ownedFence(root, op, input, pod);
    imagePatch(pod, fence, input.images);
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(root.gatewayId, fence, { ...fence, phase: 'dispatched' });
    return fence;
  });
}
function installedGateway(pod: Row, input: SourceRecovery): string | null {
  const spec = pod.spec?.containers?.find((container: Row) => container.name === 'gateway');
  const status = pod.status?.containerStatuses?.find((container: Row) => container.name === 'gateway');
  return spec?.image === input.images.gateway && status?.state?.running && typeof status.imageID === 'string' &&
    status.imageID.endsWith(`@${input.images.gateway!.split('@')[1]}`) ? status.imageID : null;
}
function doctorComplete(fence: Row, input: SourceRecovery): boolean {
  const doctor = object(fence.doctor), image = object(fence.installedImage);
  return [doctor.requestId === fence.attemptId, doctor.error === undefined,
    Number.isSafeInteger(doctor.startedAt), doctor.startedAt > 0, Number.isSafeInteger(doctor.completedAt), doctor.completedAt >= doctor.startedAt,
    typeof doctor.releaseKey === 'string', Boolean(doctor.releaseKey),
    isDeepStrictEqual(doctor.verifiedAgentIds, input.postgresAgentStores?.map(row => row.agentId) ?? input.assignments.map(row => row.agentId)),
    image.podUid === fence.target.podUid, typeof image.gatewayImageId === 'string',
    String(image.gatewayImageId).endsWith(`@${input.images.gateway!.split('@')[1]}`)].every(Boolean);
}
async function recordInstalled(deps: Deps, op: Operation, input: SourceRecovery, pod: Row, imageID: string): Promise<boolean> {
  return deps.store.transaction({ label: 'shared-source-runtime.recordInstalled' }, async tx => {
    const root = await authority(tx, op, input), fence = ownedFence(root, op, input, pod);
    const proof = { podUid: pod.metadata.uid, gatewayImageId: imageID, verifiedAt: (deps.now ?? Date.now)() };
    if (fence.installedImage !== undefined) {
      const installed = object(fence.installedImage);
      if (installed.podUid !== proof.podUid || installed.gatewayImageId !== imageID) throw new Error('source recovery installed image proof changed');
      return false;
    }
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(root.gatewayId, fence, { ...fence, installedImage: proof });
    return true;
  });
}
async function finish(deps: Deps, op: Operation, input: SourceRecovery, pod: Row, managementHealth?: Row): Promise<void> {
  await deps.store.transaction({ label: 'shared-source-runtime.finish' }, async tx => {
    const root = await authority(tx, op, input), fence: Row = ownedFence(root, op, input, pod);
    if (!managementHealth) throw new Error('source management health is unavailable');
    if (!doctorComplete(fence, input) || !recoveredPodReady(pod, fence.target, input.images)) throw new Error('source repair acknowledgment is unavailable');
    const completedAt = (deps.now ?? Date.now)();
    const release = input.postgresAgentStores ? await recordRecoveredGatewayReleaseInStore(tx, {
      gatewayId: root.gatewayId, operationId: op.id, claimedStartedAt: op.startedAt, payload: input.payload!, now: completedAt,
    }) : undefined;
    await tx.journal.operations.patch(op.id, { sourceRuntimeRecovery: { gatewayId: root.gatewayId,
      sourceSha: input.sourceSha, images: input.images, podUid: pod.metadata.uid, doctor: fence.doctor, installedImage: fence.installedImage,
      ...(release ? { release, workload: fence.target.workload } : {}),
      ...(managementHealth ? { managementHealth } : {}), completedAt } });
    await tx.gateways.roots.patch(root.gatewayId, { runtimeRestartFence: { clear: true } });
  });
}
function ownsPausedSourceWorkload(fence: Row, op: Operation, input: SourceRecovery): boolean {
  const predecessor = input.supersede;
  return fence.kind === 'source-recovery' && (fence.attemptId === op.id ||
    predecessor !== undefined && fence.attemptId === predecessor.operationId && isDeepStrictEqual(fence, predecessor.fence));
}
async function preflightNewPostgresSource(request: {
  deps: Deps; op: Operation; input: SourceRecovery; ctx: OperationContext; pod: Row; ownFence: Row;
}): Promise<void> {
  const { deps, op, input, ctx, pod, ownFence } = request;
  if (!input.postgresAgentStores || Object.keys(ownFence).length !== 0) return;
  await ctx.assertActiveClaim!();
  await deps.store.transaction({ label: 'shared-source-runtime.preflight', readOnly: true }, async tx => { await authority(tx, op, input); });
  await assertSourceRecoveryDiscovery(deps, pod, input.postgresAgentStores);
  await ctx.assertActiveClaim!();
  const currentPod = await json(deps, ['get', 'pod', pod.metadata.name]);
  if (currentPod.metadata?.uid !== pod.metadata.uid || currentPod.metadata.deletionTimestamp) throw new Error('source discovery Pod custody changed');
}
export async function recoverSharedSourceRuntime(deps: Deps, op: Operation, ctx: OperationContext): Promise<void> {
  const input = sourceRecovery(op, deps.sourceSha), gatewayId = op.input.gatewayId as string;
  if (!ctx.assertActiveClaim) throw new Error('source recovery operation claim is unavailable');
  await ctx.assertActiveClaim();
  const prior = object((await deps.store.journal.operations.get(op.id))?.sourceRuntimeRecovery);
  if (prior.completedAt > 0 && prior.sourceSha === input.sourceSha && isDeepStrictEqual(prior.images, input.images)) {
    if (input.postgresAgentStores) await resumeRecoveredSource(deps, op, input, ctx);
    return;
  }
  const pod = await existingOwnedPod(deps, gatewayId);
  const ownFence = object((await deps.store.gateways.roots.get(gatewayId))?.runtimeRestartFence);
  const workload = input.postgresAgentStores ? await captureSourceRecoveryWorkload(deps, gatewayId, pod,
    ownsPausedSourceWorkload(ownFence, op, input)) : undefined;
  await preflightNewPostgresSource({ deps, op, input, ctx, pod, ownFence });
  await reserve(deps, op, input, pod, workload);
  const saved = await dispatch(deps, op, input, pod);
  if (workload) await pinSourceRecoveryImages(deps, workload, input.images, saved.target.originalImages, async () => {
    await ctx.assertActiveClaim!();
    await deps.store.transaction({ label: 'shared-source-runtime.assertOwnedFence', readOnly: true }, async tx => { ownedFence(await authority(tx, op, input), op, input, pod); });
  });
  if (Object.entries(input.images).some(([name, image]) => pod.spec.containers.find((container: Row) => container.name === name)?.image !== image)) {
    await ctx.assertActiveClaim();
    await json(deps, ['patch', 'pod', pod.metadata.name, '--type=json', '-p', JSON.stringify(imagePatch(pod, saved, input.images))]);
  }
  await waitForSourceRepair({ deps, op, input, ctx, pod, saved });
  if (workload) await resumeRecoveredSource(deps, op, input, ctx);
}

function completedSourceRootMatches(root: Row, input: SourceRecovery, release: number): boolean {
  return ['gatewayId', 'gatewayClass', 'ownerUid', 'builderSlug'].every(key => root[key] === input.root[key]) &&
    ['running', 'draining'].includes(root.desiredStatus) && root.desiredRelease === release &&
    root.runtimeRestartFence === undefined && root.retirementClaim == null;
}
function completedSourceReceiptMatches(current: Row, op: Operation, input: SourceRecovery): boolean {
  const proof = object(current.sourceRuntimeRecovery);
  return current.status === 'running' && current.startedAt === op.startedAt && current.cancellationRequestedAt === undefined &&
    isDeepStrictEqual(current.input, op.input) && proof.sourceSha === input.sourceSha && isDeepStrictEqual(proof.images, input.images) &&
    proof.completedAt > 0 && Boolean(proof.workload) && Number.isSafeInteger(proof.release?.release);
}
async function resumeRecoveredSource(deps: Deps, op: Operation, input: SourceRecovery, ctx: OperationContext): Promise<void> {
  const read = async () => {
    await ctx.assertActiveClaim!();
    const [current, root] = await Promise.all([deps.store.journal.operations.get(op.id), deps.store.gateways.roots.get(op.input.gatewayId as string)]);
    const proof = object(current?.sourceRuntimeRecovery);
    if (!completedSourceReceiptMatches(object(current), op, input) ||
        !completedSourceRootMatches(object(root), input, proof.release.release)) {
      throw new Error('completed source recovery release custody changed');
    }
    return proof;
  };
  const proof = await read();
  await resumeSourceRecoveryWorkload(deps, proof.workload, input.images, async () => { await read(); });
}
function sourceRepairTimeout(): number {
  return 1_200_000;
}
async function waitForSourceRepair(request: {
  deps: Deps; op: Operation; input: SourceRecovery; ctx: OperationContext; pod: Row; saved: Row;
}): Promise<void> {
  const { deps, op, input, ctx, pod, saved } = request;
  const gatewayId = op.input.gatewayId as string;
  const now = deps.now ?? Date.now, wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + sourceRepairTimeout();
  while (now() < deadline) {
    await ctx.assertActiveClaim!();
    const current = await json(deps, ['get', 'pod', pod.metadata.name]);
    if (current.metadata?.uid !== pod.metadata.uid || current.metadata.deletionTimestamp) throw new Error('source repair Pod was replaced; outcome remains fenced');
    imagePatch(current, saved, input.images);
    const imageID = installedGateway(current, input);
    if (imageID && await recordInstalled(deps, op, input, current, imageID)) continue;
    const fence = object((await deps.store.gateways.roots.get(gatewayId))?.runtimeRestartFence);
    assertOwnedFence(fence, op, input, current);
    if (fence.doctor?.error !== undefined) throw new Error('source Doctor failed; outcome remains fenced');
    if (doctorComplete(fence, input) && recoveredPodReady(current, fence.target, input.images)) {
      if (input.postgresAgentStores) {
        const proof = await managementHealth(deps, op, current);
        await ctx.assertActiveClaim!();
        const after = await json(deps, ['get', 'pod', pod.metadata.name]);
        await finish(deps, op, input, after, proof);
      } else await finish(deps, op, input, current);
      return;
    }
    await wait(1000);
  }
  throw new Error('source repair is not ready; outcome remains fenced');
}

async function managementHealth(deps: Deps, op: Operation, pod: Row): Promise<Row> {
  const result = await deps.runKubectl(['-n', deps.namespace, 'exec', pod.metadata.name, '-c', 'gateway', '-i', '--', 'node', '--input-type=commonjs', '-', op.id],
    { stdin: managementHealthDriverSource(), timeoutMs: 50_000 }).catch(cause => {
      throw new Error('source management health unconfirmed; outcome remains fenced', { cause });
    });
  if (result.code !== 0) throw new Error('source management health unconfirmed; outcome remains fenced');
  let proof: Row;
  try { proof = JSON.parse(result.stdout.trim()); } catch { throw new Error('source management health receipt invalid'); }
  if (!isDeepStrictEqual(Object.keys(proof).sort(), ['attemptId', 'bootId', 'health', 'version']) || proof.version !== 1 || proof.attemptId !== op.id ||
    proof.health !== true || typeof proof.bootId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(proof.bootId)) throw new Error('source management health receipt invalid');
  return proof;
}
