import type { SurgePod, SurgePodHealth } from './surge-user-handoff.js';
import { builderActivateOperationId } from '@octogee/core/user-activation-lease';
import { userActivationRecoveryTargetMatches } from '@octogee/core/fleet-state';
import { isolatedRuntimeMutationFenced } from '@octogee/core/gateway-retirement-claim';
import type {
  PlatformUserRecord,
  GatewayAssignment,
  GatewayRoot,
  OperationRecord,
  PlatformStateRepositories,
  Stored,
} from '@octogee/core/platform-state';
import type { DurableGateway } from './converge-gateway.js';
import { readSchedulerMigrationIdentity, type UserActivationTargetRollbackProof } from '@octogee/shared/types/glm';
import { readWorkspaceMigrationMarker } from '@octogee/shared/types/workspace-migration';

export type { UserActivationTargetRollbackProof } from '@octogee/shared/types/glm';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface UserActivationRollRecovery {
  operationId: string;
  migrationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  sourceEpoch: number;
  targetGatewayId: string;
  leaseId: string;
  generation: number;
  liveRelease: number;
  desiredRelease: number;
  latestRelease: number;
}

export interface UserActivationRollRecoveryRecords {
  gateway: GatewayRoot;
  operation: OperationRecord;
  user: Stored<PlatformUserRecord> | null;
  sourceRoot: GatewayRoot | null;
  sourceAssignment: GatewayAssignment | null;
  targetOccupied: boolean;
}

function userHoldsRecovery(user: Stored<PlatformUserRecord> | null, request: Record<string, unknown>, operationId: unknown): boolean {
  if (user === null) return false;
  const marker = readWorkspaceMigrationMarker({ migration: user.fences.migration });
  return [!isolatedRuntimeMutationFenced(user), user.slug === request.userSlug, user.gateway?.gatewayId === request.fromGatewayId,
    marker?.operationId === operationId, marker?.state === 'moving'].every(Boolean);
}

function qualifyUserActivationRollRecoveryState(input: UserActivationRollRecoveryRecords, custodyOnly: boolean): UserActivationRollRecovery | null {
  const gateway = record(input.gateway), operation = record(input.operation), user = input.user;
  const request = record(operation.input);
  const lease = record(user?.activationLease), allocation = record(gateway.allocation);
  const sourceRoot = record(input.sourceRoot), assignment = record(input.sourceAssignment);
  const handoff = record(operation.schedulerHandoff), recovery = record(handoff.sourceRecovery);
  const identity = readSchedulerMigrationIdentity(String(operation.id), handoff.migrationId);
  const operationId = typeof gateway.gatewayId === 'string' && Number.isSafeInteger(lease.generation) && Number(lease.generation) > 0
    ? builderActivateOperationId(gateway.gatewayId, Number(lease.generation)) : null;
  const checks = [
    operationId !== null, operation.id === operationId, operation.kind === 'migrate-user',
    operationHoldsRecoveryCustody(operation, custodyOnly),
    operation.cancellationRequestedAt === undefined, operation.cutoverCommittedAt === undefined,
    operation.userMigrationV2 === undefined, operation.sourceTransferExecution === undefined,
    operation.schedulerHandoffReleased !== true, operation.rolledBack !== true,
    request.recoverSourceOnly === true, request.sourceTransferMode === undefined,
    typeof request.uid === 'string', request.uid !== '', typeof request.userSlug === 'string', request.userSlug !== '',
    typeof request.fromGatewayId === 'string', String(request.fromGatewayId).startsWith('shared-'),
    request.toGatewayId === gateway.gatewayId, request.fromGatewayId !== gateway.gatewayId,
    gateway.desiredStatus === 'running', gateway.runtimeRestartFence === undefined,
    gateway.gatewayClass === 'isolated', allocation.kind === 'disposable-builder',
    Number.isSafeInteger(gateway.liveRelease), Number(gateway.liveRelease) > 0,
    Number.isSafeInteger(gateway.desiredRelease), Number(gateway.desiredRelease) > Number(gateway.liveRelease),
    Number.isSafeInteger(gateway.latestRelease), Number(gateway.latestRelease) >= Number(gateway.desiredRelease),
    !input.targetOccupied, userHoldsRecovery(user, request, operation.id),
    sourceRoot.gatewayClass === 'shared', sourceRoot.gatewayId === request.fromGatewayId,
    sourceRoot.desiredStatus === 'running' || sourceRoot.desiredStatus === 'draining', sourceRoot.runtimeRestartFence === undefined,
    assignment.uid === request.uid, assignment.slug === request.userSlug, assignment.gatewayId === request.fromGatewayId,
    assignment.state === 'quiescing', assignment.updatedByOperationId === operation.id,
    Number.isSafeInteger(assignment.epoch), Number(assignment.epoch) >= 0,
    identity !== null, handoff.uid === request.uid, handoff.slug === request.userSlug,
    handoff.fromGatewayId === request.fromGatewayId, handoff.toGatewayId === request.toGatewayId,
    handoff.stageAfterCutover === true, handoff.stagedAt === undefined,
    recovery.migrationId === handoff.migrationId, recovery.sourceEpoch === assignment.epoch,
    Array.isArray(recovery.steps) && recovery.steps.some(value => record(value).name === 'quiesce-source' && record(value).status === 'done'),
    userActivationRecoveryTargetMatches({ operationId: String(operation.id), input: request,
      openclaw: { activationLease: user?.activationLease ?? undefined }, sourceEpoch: Number(assignment.epoch), targetRoot: gateway }),
  ];
  if (!checks.every(Boolean)) return null;
  return {
    operationId: String(operation.id), migrationId: String(handoff.migrationId), uid: String(request.uid), slug: String(request.userSlug),
    sourceGatewayId: String(request.fromGatewayId), sourceEpoch: Number(assignment.epoch), targetGatewayId: String(gateway.gatewayId),
    leaseId: String(lease.leaseId), generation: Number(lease.generation), liveRelease: Number(gateway.liveRelease),
    desiredRelease: Number(gateway.desiredRelease), latestRelease: Number(gateway.latestRelease),
  };
}

function operationHoldsRecoveryCustody(operation: Record<string, unknown>, custodyOnly: boolean): boolean {
  const pending = operation.status === 'pending' && operation.startedAt === null;
  const claimedUnsettled = (operation.status === 'running' || operation.status === 'failed') &&
    Number.isSafeInteger(operation.startedAt) && Number(operation.startedAt) > 0;
  return pending || custodyOnly && claimedUnsettled;
}

export function qualifyUserActivationRollRecovery(input: UserActivationRollRecoveryRecords): UserActivationRollRecovery | null {
  return qualifyUserActivationRollRecoveryState(input, false);
}

export function hasUserActivationTargetRollback(operation: {
  id: string;
  input?: Record<string, unknown>;
  schedulerHandoff?: unknown;
}, expected?: UserActivationRollRecovery): boolean {
  const handoff = record(operation.schedulerHandoff), recovery = record(handoff.sourceRecovery), input = operation.input;
  const proof = record(recovery.targetRollback);
  return [
    typeof proof.retainedPodUid === 'string', proof.retainedPodUid !== '', Number.isFinite(proof.completedAt),
    typeof proof.uid === 'string', proof.uid !== '', typeof proof.slug === 'string', proof.slug !== '',
    typeof proof.leaseId === 'string', proof.leaseId !== '', Number.isSafeInteger(proof.generation), Number(proof.generation) > 0,
    typeof proof.targetGatewayId === 'string' && Number.isSafeInteger(proof.generation) && Number(proof.generation) > 0 &&
      builderActivateOperationId(proof.targetGatewayId, Number(proof.generation)) === operation.id,
    expected === undefined || proof.leaseId === expected.leaseId && proof.generation === expected.generation && proof.sourceEpoch === expected.sourceEpoch,
    Number.isSafeInteger(proof.sourceEpoch), Number(proof.sourceEpoch) >= 0,
    readSchedulerMigrationIdentity(operation.id, handoff.migrationId) !== null,
    proof.operationId === operation.id, proof.migrationId === handoff.migrationId,
    proof.migrationId === recovery.migrationId, proof.sourceEpoch === recovery.sourceEpoch,
    proof.uid === input?.uid, proof.slug === input?.userSlug, proof.uid === handoff.uid, proof.slug === handoff.slug,
    proof.sourceGatewayId === input?.fromGatewayId, proof.sourceGatewayId === handoff.fromGatewayId,
    proof.targetGatewayId === input?.toGatewayId, proof.targetGatewayId === handoff.toGatewayId,
  ].every(Boolean);
}

type HeldRollbackPod = SurgePod;
interface HeldRollbackObservation {
  pods: readonly HeldRollbackPod[];
  observedPodUids: readonly string[];
  health: ReadonlyMap<string, SurgePodHealth | null>;
}

export interface HeldIsolatedTargetRollbackDeps {
  readCurrent: () => Promise<UserActivationRollRecovery | null>;
  assertRollClaim: () => Promise<void>;
  observe: () => Promise<HeldRollbackObservation>;
  assertTemplateRollback: (pods: { retainedPodUid: string; discardedPodUid: string | null }) => Promise<void>;
  cleanupRetained: (recovery: UserActivationRollRecovery, pod: HeldRollbackPod) => Promise<void>;
  applyLiveArtifact: (recovery: UserActivationRollRecovery) => Promise<void>;
  recordProof: (proof: UserActivationTargetRollbackProof) => Promise<void>;
  now: () => number;
  wait: () => Promise<void>;
}

function heldRollbackPod(observation: HeldRollbackObservation, pod: HeldRollbackPod, slug: string): boolean {
  const health = observation.health.get(pod.uid);
  return !pod.ready && !pod.terminating && !pod.crashLooping &&
    health?.fleetSignatureCapability === 'gateway-scoped' && health.status === 'booting' &&
    health.prelaunchState === 'held' && !health.handoffReleased && health.mountedCustomers.length === 0 &&
    Array.isArray(health.migratingIn) && health.migratingIn.every(item => item === slug);
}

function selectHeldRollbackPods(initial: HeldRollbackObservation, slug: string, liveImage: string, installedImage: string) {
  const checks = [initial.pods.length >= 1, initial.pods.length <= 2, initial.observedPodUids.length === initial.pods.length,
    initial.observedPodUids.every(uid => initial.pods.some(pod => pod.uid === uid)),
    initial.pods.every(pod => heldRollbackPod(initial, pod, slug)),
    initial.pods.filter(pod => pod.image !== liveImage).every(pod => initial.health.get(pod.uid)?.migratingIn?.length === 0),
    /@sha256:[a-f0-9]{64}$/.test(liveImage), /@sha256:[a-f0-9]{64}$/.test(installedImage)];
  if (!checks.every(Boolean)) return null;
  const predecessors = initial.pods.filter(pod => pod.image === liveImage);
  const replacements = initial.pods.filter(pod => pod.image === installedImage && pod.image !== liveImage);
  const retained = predecessors[0];
  if (predecessors.length !== 1 || !retained || (initial.pods.length === 2 && replacements.length !== 1) ||
      initial.pods.some(pod => pod !== retained && !replacements.includes(pod))) return null;
  return { retained, replacements };
}

function assertUnchangedHeldRollbackPods(initial: HeldRollbackObservation, current: HeldRollbackObservation, slug: string, retainedUid: string): void {
  if (JSON.stringify(current.pods) !== JSON.stringify(initial.pods) || !current.pods.every(pod => heldRollbackPod(current, pod, slug)) ||
      !current.pods.filter(pod => pod.uid !== retainedUid).every(pod => current.health.get(pod.uid)?.migratingIn?.length === 0)) throw new Error('Isolated target rollback allocations changed before cleanup');
}

async function awaitHeldPredecessor(input: {
  deps: HeldIsolatedTargetRollbackDeps; observe: () => Promise<HeldRollbackObservation>; initial: HeldRollbackObservation;
  retained: HeldRollbackPod; liveImage: string; slug: string; timeoutMs: number;
}): Promise<void> {
  const { deps, initial, retained } = input;
  const deadline = deps.now() + input.timeoutMs;
  for (;;) {
    const current = await input.observe();
    if (current.observedPodUids.some(uid => !initial.observedPodUids.includes(uid))) throw new Error('Isolated target rollback observed an unknown allocation');
    const predecessor = current.pods.find(pod => pod.uid === retained.uid);
    const checks = [predecessor?.name === retained.name, predecessor?.podIP === retained.podIP, predecessor?.image === input.liveImage,
      predecessor !== undefined && heldRollbackPod(current, predecessor, input.slug)];
    if (!checks.every(Boolean)) throw new Error('Isolated target rollback lost its held predecessor');
    if (current.pods.length === 1 && current.observedPodUids.length === 1 && current.observedPodUids[0] === retained.uid) return;
    if (deps.now() >= deadline) throw new Error('Isolated target rollback did not retain exactly one held allocation before its deadline');
    await deps.wait();
  }
}

export async function rollbackHeldUserActivationTarget(input: {
  deps: HeldIsolatedTargetRollbackDeps;
  liveImage: string;
  installedImage: string;
  rollOperationId: string;
  rollClaimStartedAt: number;
  timeoutMs: number;
}): Promise<UserActivationTargetRollbackProof | null> {
  const { deps } = input;
  await deps.assertRollClaim();
  const recovery = await deps.readCurrent();
  if (!recovery) return null;
  const assertCurrent = async () => {
    await deps.assertRollClaim();
    if (JSON.stringify(await deps.readCurrent()) !== JSON.stringify(recovery)) throw new Error('Isolated target rollback recovery authority changed');
    await deps.assertRollClaim();
  };
  const observe = async () => {
    await assertCurrent(); const value = await deps.observe(); await assertCurrent(); return value;
  };
  const initial = await observe();
  const selection = selectHeldRollbackPods(initial, recovery.slug, input.liveImage, input.installedImage);
  if (!selection) return null;
  const { retained, replacements } = selection;
  const beforeCleanup = await observe();
  assertUnchangedHeldRollbackPods(initial, beforeCleanup, recovery.slug, retained.uid);
  await deps.assertTemplateRollback({ retainedPodUid: retained.uid, discardedPodUid: replacements[0]?.uid ?? null }); await assertCurrent();
  await deps.cleanupRetained(recovery, retained);
  await assertCurrent();
  const cleaned = await observe();
  assertUnchangedHeldRollbackPods(initial, cleaned, recovery.slug, retained.uid);
  if (cleaned.health.get(retained.uid)?.migratingIn?.length !== 0) throw new Error('User predecessor cleanup was not proven');
  await deps.assertTemplateRollback({ retainedPodUid: retained.uid, discardedPodUid: replacements[0]?.uid ?? null }); await assertCurrent();
  await deps.applyLiveArtifact(recovery); await assertCurrent();
  await awaitHeldPredecessor({ deps, observe, initial, retained, liveImage: input.liveImage, slug: recovery.slug, timeoutMs: input.timeoutMs });
  await assertCurrent();
  const proof = { ...recovery, retainedPodUid: retained.uid, discardedPodUid: replacements[0]?.uid ?? null,
    rollOperationId: input.rollOperationId, rollClaimStartedAt: input.rollClaimStartedAt, completedAt: deps.now() };
  await deps.recordProof(proof); await assertCurrent(); return proof;
}

export interface UserActivationRollRecoveryRead {
  state: Pick<PlatformStateRepositories, 'gateways' | 'journal' | 'users'>;
  gatewayId: string;
}

async function readUserActivationRollRecoveryState(input: UserActivationRollRecoveryRead, custodyOnly: boolean):
  Promise<{ recovery: UserActivationRollRecovery; operation: Stored<OperationRecord>; gateway: DurableGateway } | null> {
  const { state, gatewayId } = input;
  const gateway = await state.gateways.roots.get(gatewayId);
  const allocation = gateway?.allocation;
  if (!gateway || gateway.gatewayClass !== 'isolated' || allocation?.kind !== 'disposable-builder' || typeof gateway.ownerUid !== 'string' ||
      !Number.isSafeInteger(allocation.generation) || allocation.generation <= 0) return null;
  const operationId = builderActivateOperationId(gatewayId, allocation.generation);
  const [operation, user] = await Promise.all([
    state.journal.operations.get(operationId), state.users.records.get(gateway.ownerUid),
  ]);
  const request = record(operation?.input);
  if (!operation || typeof request.fromGatewayId !== 'string' || typeof request.uid !== 'string') return null;
  const [sourceRoot, sourceAssignment, targetEmpty, targetUsers] = await Promise.all([
    state.gateways.roots.get(request.fromGatewayId),
    state.gateways.assignments.get(request.fromGatewayId, request.uid),
    state.gateways.assignments.isEmpty(gatewayId),
    state.users.records.listByGateway(gatewayId, { limit: 1 }),
  ]);
  const recovery = qualifyUserActivationRollRecoveryState({ gateway, operation, user, sourceRoot, sourceAssignment,
    targetOccupied: !targetEmpty || targetUsers.length > 0 }, custodyOnly);
  const { revision: _revision, ...durable } = gateway;
  return recovery ? { recovery, operation, gateway: durable } : null;
}

export function readUserActivationRollRecovery(input: UserActivationRollRecoveryRead) {
  return readUserActivationRollRecoveryState(input, false);
}

export function readUserActivationRollRecoveryCustody(input: UserActivationRollRecoveryRead) {
  return readUserActivationRollRecoveryState(input, true);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(record(value)[key])]));
}

function imageLabel(tag: string): string | null {
  return /^[a-f0-9]{7}/.exec(tag.split('@', 1)[0] ?? '')?.[0] ?? null;
}

export function heldIsolatedRollbackTemplatesMatch(input: {
  predecessorTemplate: unknown;
  installedTemplate: unknown;
  liveImage: { gateway: string; edge: string; tag: string };
  installedImage: { gateway: string; edge: string; tag: string };
  chartFingerprint: string;
  installedChartFingerprint: string | undefined;
  reconstructedIntentFingerprint: string;
  installedIntentFingerprint: string | undefined;
}): boolean {
  if (!input.chartFingerprint || input.chartFingerprint !== input.installedChartFingerprint ||
      !input.reconstructedIntentFingerprint || input.reconstructedIntentFingerprint !== input.installedIntentFingerprint) return false;
  const predecessor = structuredClone(record(input.predecessorTemplate));
  const installed = structuredClone(record(input.installedTemplate));
  const oldMetadata = record(predecessor.metadata), newMetadata = record(installed.metadata);
  const oldLabels = record(oldMetadata.labels), newLabels = record(newMetadata.labels);
  const oldLabel = imageLabel(input.liveImage.tag), newLabel = imageLabel(input.installedImage.tag);
  if (!oldLabel || !newLabel || oldLabels['gateway-image'] !== oldLabel || newLabels['gateway-image'] !== newLabel) return false;
  delete oldLabels['pod-template-hash']; delete newLabels['pod-template-hash'];
  oldLabels['gateway-image'] = newLabel;
  oldMetadata.labels = oldLabels; newMetadata.labels = newLabels; predecessor.metadata = oldMetadata; installed.metadata = newMetadata;
  return rewriteRollbackTemplateImages(predecessor, input.liveImage, input.installedImage) &&
    JSON.stringify(canonical(predecessor)) === JSON.stringify(canonical(installed));
}

function rewriteRollbackGatewayTag(container: Record<string, unknown>, oldTag: string, newTag: string): boolean | null {
  if (container.name !== 'gateway' || !Array.isArray(container.env)) return false;
  const entry = container.env.map(record).find(value => value.name === 'GATEWAY_IMAGE_TAG');
  if (!entry || entry.value !== oldTag) return null;
  entry.value = newTag; return true;
}

function rewriteRollbackTemplateImages(template: Record<string, unknown>, live: { gateway: string; edge: string; tag: string }, installed: { gateway: string; edge: string; tag: string }): boolean {
  const spec = record(template.spec); let gatewayFound = false, edgeFound = false, tagFound = false;
  const containers = [spec.initContainers, spec.containers].flatMap(value => Array.isArray(value) ? value : []);
  for (const value of containers) {
    const container = record(value);
    if (container.image === live.gateway) { container.image = installed.gateway; gatewayFound = true; }
    else if (container.image === live.edge) { container.image = installed.edge; edgeFound = true; }
    const tag = rewriteRollbackGatewayTag(container, live.tag, installed.tag);
    if (tag === null) return false;
    tagFound ||= tag;
  }
  return gatewayFound && edgeFound && tagFound;
}
