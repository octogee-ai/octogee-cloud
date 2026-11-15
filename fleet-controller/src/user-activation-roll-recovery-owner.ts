import type { PlatformStateStore, PlatformStateTransaction } from '@octogee/core/platform-state';
import type { Operation, SchedulerHandoffState } from '@octogee/shared/types/glm';
import type { ReleasePayload } from '@octogee/shared/types/gateway-releases';
import type { OperationContext } from './operation-router.js';
import type { HelmRunner } from './helm-runner.js';
import { gatewayImageFor, type DurableGateway, type GatewayUpsertOpts } from './converge-gateway.js';
import type { SurgeUserHandoffDeps, SurgePod } from './surge-user-handoff.js';
import { isReleasedSurgeTargetHold } from './surge-user-handoff-runtime.js';
import { heldIsolatedRollbackTemplatesMatch, readUserActivationRollRecovery, rollbackHeldUserActivationTarget,
  type UserActivationRollRecovery, type UserActivationTargetRollbackProof } from './user-activation-roll-recovery.js';

class UserActivationRollbackUnavailableError extends Error {}

interface OwnerDeps {
  store: PlatformStateStore;
  namespace: string;
  helm: HelmRunner;
  chartFingerprint: string;
  runExclusive: (work: () => Promise<void>) => Promise<void>;
  readRelease: (gatewayId: string, release: number) => Promise<ReleasePayload | null>;
  prepareIntent: (gateway: DurableGateway, artifact: ReleasePayload) => Promise<GatewayUpsertOpts>;
  listPods: SurgeUserHandoffDeps['listPods'];
  readPodHealth: SurgeUserHandoffDeps['readPodHealth'];
  holdTarget: NonNullable<SurgeUserHandoffDeps['holdTargetOpenClaw']>;
  unreserveTarget: NonNullable<SurgeUserHandoffDeps['unreserveTargetOpenClaw']>;
  readTemplateObjects: (gatewayId: string) => Promise<unknown>;
  now: () => number;
  wait: () => Promise<void>;
  log: (message: string) => void;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function controllerUid(value: Record<string, unknown>): unknown {
  return list(record(value.metadata).ownerReferences).find(owner => owner.controller === true)?.uid;
}
function sameRecovery(left: UserActivationRollRecovery, right: UserActivationRollRecovery | undefined): boolean {
  return right !== undefined && Object.entries(left).every(([key, value]) => right[key as keyof UserActivationRollRecovery] === value);
}

function predecessorTemplate(objects: unknown, gatewayId: string, retainedPodUid: string, discardedPodUid: string | null) {
  const items = list(record(objects).items);
  const deployments = items.filter(item => item.kind === 'Deployment' && record(item.metadata).name === `octogee-gateway-${gatewayId}`);
  if (deployments.length !== 1) throw new Error('User rollback has no exact Deployment');
  const deployment = deployments[0];
  const pods = items.filter(item => item.kind === 'Pod');
  if (pods.length !== (discardedPodUid ? 2 : 1) || pods.some(pod => ![retainedPodUid, discardedPodUid].includes(String(record(pod.metadata).uid)))) throw new Error('User rollback template allocations changed');
  const retained = pods.find(pod => record(pod.metadata).uid === retainedPodUid);
  const replicaSets = items.filter(item => item.kind === 'ReplicaSet' && controllerUid(item) === record(deployment.metadata).uid);
  const predecessor = replicaSets.find(replicaSet => record(replicaSet.metadata).uid === (retained && controllerUid(retained)));
  if (!predecessor || pods.some(pod => !replicaSets.some(replicaSet => record(replicaSet.metadata).uid === controllerUid(pod)))) throw new Error('User rollback PodTemplate ownership changed');
  return { predecessorTemplate: record(predecessor.spec).template, installedTemplate: record(deployment.spec).template };
}

async function assertOwnedRoll(op: Operation, ctx: OperationContext, transaction?: PlatformStateTransaction): Promise<void> {
  if (!ctx.assertActiveClaim) throw new Error('Held user rollback requires its current rollout claim');
  if (!transaction) { await ctx.assertActiveClaim(); return; }
  const current = await transaction.journal.operations.get(op.id);
  if (current?.kind !== 'rollout' || current.status !== 'running' || current.startedAt !== op.startedAt || current.cancellationRequestedAt !== undefined ||
      current.input?.gatewayId !== op.input.gatewayId || current.input?.targetRelease !== op.input.targetRelease) throw new Error('Held user rollback rollout claim changed');
}

function withTargetRollback(handoff: SchedulerHandoffState | undefined, proof: UserActivationTargetRollbackProof): SchedulerHandoffState {
  if (!handoff?.sourceRecovery) throw new Error('User rollback recovery changed before journaling');
  return { ...handoff, sourceRecovery: { ...handoff.sourceRecovery, targetRollback: proof } };
}

async function recordRollbackProof(deps: OwnerDeps, op: Operation, ctx: OperationContext, proof: UserActivationTargetRollbackProof): Promise<void> {
  await deps.store.transaction({ label: 'builder-activation-roll-recovery.record-proof' }, async transaction => {
    await assertOwnedRoll(op, ctx, transaction);
    const current = await readUserActivationRollRecovery({ state: transaction, gatewayId: proof.targetGatewayId });
    if (!current || !sameRecovery(current.recovery, proof)) throw new Error('User rollback recovery changed before journaling');
    await transaction.journal.operations.patch(proof.operationId, { schedulerHandoff: withTargetRollback(current.operation.schedulerHandoff, proof) },
      { revision: current.operation.revision });
  });
}

function artifactHasEdge(artifact: ReleasePayload | null): artifact is ReleasePayload & { gatewayEdgeImage: NonNullable<ReleasePayload['gatewayEdgeImage']> } {
  return artifact?.gatewayEdgeImage !== undefined;
}

async function readClusterRollbackRelease(
  deps: OwnerDeps, op: Operation, ctx: OperationContext, expected: UserActivationRollRecovery,
): Promise<number | null> {
  const gatewayId = expected.targetGatewayId;
  const runtime = await deps.store.fleetRegistry.get(gatewayId);
  if (runtime?.runtime === 'gce-vm') {
    const current = await readUserActivationRollRecovery({ state: deps.store, gatewayId });
    await assertOwnedRoll(op, ctx);
    if (!sameRecovery(expected, current?.recovery)) return null;
    // A held VM cannot adopt this release, and only source recovery owns its
    // cleanup. End this roll's claim rather than keeping recovery serialized.
    throw new Error(`rollout ${gatewayId} cannot replace an unadmitted gce-vm target; source recovery ${expected.operationId} must finish`);
  }
  return runtime?.runtime === 'cluster' && Number.isSafeInteger(runtime.release) ? runtime.release : null;
}

async function rollbackOwnedTarget(deps: OwnerDeps, op: Operation, ctx: OperationContext): Promise<UserActivationTargetRollbackProof | null> {
  const gatewayId = String(op.input.gatewayId);
  await assertOwnedRoll(op, ctx);
  const initial = await readUserActivationRollRecovery({ state: deps.store, gatewayId });
  if (!initial || initial.recovery.latestRelease !== op.input.targetRelease || typeof op.startedAt !== 'number') return null;
  const installedRelease = await readClusterRollbackRelease(deps, op, ctx, initial.recovery);
  if (installedRelease === null) return null;
  const installed = await deps.helm.readDeployedInstance({ namespace: deps.namespace, gatewayId });
  if (!installed) return null;
  const liveArtifact = await deps.readRelease(gatewayId, initial.recovery.liveRelease);
  if (!artifactHasEdge(liveArtifact)) return null;
  const liveGatewayImage = gatewayImageFor(initial.gateway, liveArtifact);
  const installedIsLive = installed.image.repository === liveGatewayImage.imageRepository && installed.image.tag === liveGatewayImage.imageTag;
  const installedArtifact = installedIsLive ? liveArtifact : await deps.readRelease(gatewayId, installedRelease);
  if (!artifactHasEdge(installedArtifact)) return null;
  const installedGatewayImage = gatewayImageFor(initial.gateway, installedArtifact);
  if (installed.image.repository !== installedGatewayImage.imageRepository || installed.image.tag !== installedGatewayImage.imageTag) return null;
  const [liveIntent, installedIntent] = await Promise.all([
    deps.prepareIntent(initial.gateway, liveArtifact), deps.prepareIntent(initial.gateway, installedArtifact),
  ]);
  const liveImage = `${liveGatewayImage.imageRepository}:${liveGatewayImage.imageTag}`;
  const installedImage = `${installedGatewayImage.imageRepository}:${installedGatewayImage.imageTag}`;
  const assertCurrent = async () => {
    await assertOwnedRoll(op, ctx);
    const current = await readUserActivationRollRecovery({ state: deps.store, gatewayId });
    if (!sameRecovery(initial.recovery, current?.recovery)) throw new Error('User rollback pending recovery authority changed');
    return current!;
  };
  return rollbackHeldUserActivationTarget({ liveImage, installedImage, rollOperationId: op.id, rollClaimStartedAt: op.startedAt,
    timeoutMs: 120_000, deps: {
      assertRollClaim: () => assertOwnedRoll(op, ctx),
      readCurrent: async () => (await assertCurrent()).recovery,
      observe: async () => {
        const snapshot = await deps.listPods(gatewayId);
        const health = new Map(await Promise.all(snapshot.pods.map(async pod => [pod.uid, await deps.readPodHealth(pod, gatewayId)] as const)));
        return { ...snapshot, health };
      },
      assertTemplateRollback: async ({ retainedPodUid, discardedPodUid }) => {
        const currentInstalled = await deps.helm.readDeployedInstance({ namespace: deps.namespace, gatewayId });
        if (JSON.stringify(currentInstalled) !== JSON.stringify(installed)) throw new Error('User rollback installed Helm intent changed');
        const templates = predecessorTemplate(await deps.readTemplateObjects(gatewayId), gatewayId, retainedPodUid, discardedPodUid);
        if (!heldIsolatedRollbackTemplatesMatch({ ...templates,
          liveImage: { gateway: liveImage, edge: `${liveArtifact.gatewayEdgeImage!.imageRepository}:${liveArtifact.gatewayEdgeImage!.imageTag}`, tag: liveGatewayImage.imageTag },
          installedImage: { gateway: installedImage, edge: `${installedArtifact.gatewayEdgeImage!.imageRepository}:${installedArtifact.gatewayEdgeImage!.imageTag}`, tag: installedGatewayImage.imageTag },
          chartFingerprint: deps.chartFingerprint, installedChartFingerprint: installed.chartFingerprint,
          reconstructedIntentFingerprint: installedIntent.deploymentIntentFingerprint, installedIntentFingerprint: installed.deploymentIntentFingerprint,
        })) throw new UserActivationRollbackUnavailableError('User rollback cannot reconstruct the retained predecessor PodTemplate');
      },
      cleanupRetained: async (recovery, pod: SurgePod) => {
        await assertCurrent();
        await ctx.reportStep({ name: 'rollback-unadmitted-target', status: 'running', startedAt: deps.now() });
        const request = { gatewayId, slug: recovery.slug, operationId: `mig-${recovery.operationId}`, targetPod: pod };
        try {
          try { await deps.holdTarget(request); } catch (error) { if (!isReleasedSurgeTargetHold(error)) throw error; }
          await assertCurrent(); await deps.unreserveTarget(request); await assertCurrent();
        } catch (error) {
          await assertCurrent();
          const health = await deps.readPodHealth(pod, gatewayId);
          await assertCurrent();
          if (!health || health.status !== 'booting' || health.prelaunchState !== 'held' || health.handoffReleased || health.mountedCustomers.length > 0) throw error;
          throw new UserActivationRollbackUnavailableError(`Retained target cleanup is not qualified: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      applyLiveArtifact: async () => {
        await assertCurrent();
        await deps.helm.upsertInstance({ ...liveIntent, builderIdentity: { ownerUid: initial.recovery.uid, builderSlug: initial.recovery.slug } });
        await assertCurrent();
      },
      recordProof: async proof => {
        await recordRollbackProof(deps, op, ctx, proof);
        await ctx.reportStep({ name: 'rollback-unadmitted-target', status: 'done', completedAt: deps.now() });
        deps.log(`[rollout] ${gatewayId} retained cleaned predecessor ${proof.retainedPodUid}; source recovery ${proof.operationId} must finish before further rollout`);
      }, now: deps.now, wait: deps.wait,
    } });
}

export function createUserActivationRollRecoveryOwner(deps: OwnerDeps) {
  return async (op: Operation, ctx: OperationContext): Promise<UserActivationTargetRollbackProof | null> => {
    let proof: UserActivationTargetRollbackProof | null = null;
    await deps.runExclusive(async () => {
      try { proof = await rollbackOwnedTarget(deps, op, ctx); } catch (error) {
        if (!(error instanceof UserActivationRollbackUnavailableError)) throw error;
        await assertOwnedRoll(op, ctx);
        await ctx.reportStep({ name: 'rollback-unadmitted-target', status: 'failed', completedAt: deps.now(), error: error.message });
        deps.log(`[rollout] ${String(op.input.gatewayId)} retained-target rollback unavailable; continuing ordinary target repair: ${error.message}`);
      }
    });
    return proof;
  };
}
