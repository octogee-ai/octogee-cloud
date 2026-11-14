import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Operation } from '@octogee/shared/types/glm';
import type { ReleasePayload } from '@octogee/shared/types/gateway-releases';
import { createUserActivationRollRecoveryOwner } from '../user-activation-roll-recovery-owner.js';
import { readUserActivationRollRecovery, hasUserActivationTargetRollback } from '../user-activation-roll-recovery.js';
import { createSurgePodTransport, type SurgeControlRequest } from '../surge-user-handoff-runtime.js';
import { FLEET_KEY_PAIR } from './fixtures/fleet-keys.js';
import { buildOperationCompletionUpdate, classifyOperationFailure } from '../operation-retry.js';
import { rearmOwnedLegacyMigration } from '../legacy-migration-recovery.js';
import { createDocumentFixtureStore } from '@octogee/core/testing/journal-store';

function runtimeDoc(fields: Record<string, unknown>): Record<string, unknown> {
  return { docKind: 'runtime', gatewayId: 'builder-a', lifecycle: 'serving', ...fields };
}

function fixture(scenario = 'success') {
  const events: string[] = []; let applied = scenario === 'post-helm-crash';
  const gatewayId = 'builder-a', operationId = 'builder-activate-builder-a-g1';
  const migrationId = `mig-${operationId}:scheduler:1:claim:1000`;
  const gateway = { gatewayId, gatewayClass: 'isolated', ownerUid: 'alice', builderSlug: 'alice', desiredStatus: 'running', liveRelease: 1, desiredRelease: 2, latestRelease: 2,
    allocation: { kind: 'disposable-builder', leaseId: 'lease-a', generation: 1, claimedByUid: 'alice' } };
  const recovery = { id: operationId, kind: 'migrate-user', status: 'pending', startedAt: null, input: { uid: 'alice', userSlug: 'alice', source: 'builder-activation-lease', recoverSourceOnly: true, fromGatewayId: 'shared-a', toGatewayId: gatewayId },
    schedulerHandoff: { migrationId, uid: 'alice', slug: 'alice', fromGatewayId: 'shared-a', toGatewayId: gatewayId, stageAfterCutover: true, sourceRecovery: { migrationId, sourceEpoch: 7, steps: [{ name: 'quiesce-source', status: 'done' }] } } };
  const lease = { leaseId: 'lease-a', generation: 1, status: 'activating', sourceGatewayId: 'shared-a', sourceAssignmentEpoch: 7, targetGatewayId: gatewayId };
  const user = { username: 'alice', provisioning: { openclaw: { gatewayId: 'shared-a', slug: 'alice', activationLease: lease, migration: { state: 'moving', operationId, startedAt: 1000 } } } };
  const source = { gatewayId: 'shared-a', gatewayClass: 'shared', desiredStatus: 'running', desiredRelease: 3, latestRelease: 3 };
  const assignment = { uid: 'alice', slug: 'alice', gatewayId: 'shared-a', source: 'migrate-user', epoch: 7, state: 'quiescing', createdAt: 500, updatedAt: 500, updatedByOperationId: operationId };
  const roll = { id: 'roll-2', kind: 'rollout', status: 'running', startedAt: 2000, input: { gatewayId, targetRelease: 2 } } as unknown as Operation;
  const documents = new Map<string, Record<string, unknown>>([
    [`gateways/${gatewayId}`, gateway], [`glmOperations/${operationId}`, recovery], [`glmOperations/${roll.id}`, roll as unknown as Record<string, unknown>], ['users/alice', user],
    ['gateways/shared-a', source], ['gateways/shared-a/assignments/alice', assignment], [`glmGateways/${gatewayId}`, runtimeDoc({ runtime: 'cluster', release: 2 })],
  ]);
  const store = createDocumentFixtureStore(documents);
  const transaction = store.transaction.bind(store);
  vi.spyOn(store, 'transaction').mockImplementation((async (options: { label: string }, body: never) => {
    if (scenario === 'epoch-before-proof') assignment.epoch++;
    const result = await transaction(options, body);
    if (options.label === 'builder-activation-roll-recovery.record-proof') events.push('journal-proof');
    return result;
  }) as typeof store.transaction);
  const oldTag = 'abc1234-oc2026@sha256:' + 'a'.repeat(64), newTag = 'def1234-oc2026@sha256:' + 'b'.repeat(64);
  const artifact = (tag: string, edgeTag: string) => ({ imageRepository: 'reg/gateway', imageTag: tag, profileImages: { builder: { imageRepository: 'reg/builder', imageTag: tag } }, gatewayEdgeImage: { imageRepository: 'reg/edge', imageTag: edgeTag } }) as ReleasePayload;
  const liveArtifact = artifact(oldTag, 'abc1234@sha256:' + 'c'.repeat(64)), installedArtifact = artifact(newTag, 'def1234@sha256:' + 'd'.repeat(64));
  const retained = { uid: 'old', name: 'pod-old', podIP: '10.0.0.1', image: 'reg/builder:' + oldTag, ready: false, terminating: false, crashLooping: false };
  const target = { ...retained, uid: 'new', name: 'pod-new', podIP: '10.0.0.2', image: 'reg/builder:' + newTag };
  const health = { status: 'booting' as const, version: 'unused', fleetSignatureCapability: 'gateway-scoped' as const, handoffReleased: false, prelaunchState: 'held' as const, mountedCustomers: [], migratingIn: [] };
  const template = (tag: string, label: string, edgeTag: string) => ({ metadata: { labels: { 'gateway-image': label } }, spec: { containers: [{ name: 'gateway', image: 'reg/builder:' + tag, env: [{ name: 'GATEWAY_IMAGE_TAG', value: tag }] }, { name: 'gateway-edge', image: 'reg/edge:' + edgeTag }], serviceAccountName: 'user-sa' } });
  const oldTemplate = template(oldTag, 'abc1234', liveArtifact.gatewayEdgeImage!.imageTag), newTemplate = template(newTag, 'def1234', installedArtifact.gatewayEdgeImage!.imageTag);
  const owner = (uid: string) => [{ controller: true, uid }];
  const objects = { items: [
    { kind: 'Deployment', metadata: { uid: 'deployment', name: 'octogee-gateway-builder-a' }, spec: { template: applied ? oldTemplate : newTemplate } },
    { kind: 'ReplicaSet', metadata: { uid: 'rs-old', ownerReferences: owner('deployment') }, spec: { template: oldTemplate } },
    { kind: 'ReplicaSet', metadata: { uid: 'rs-new', ownerReferences: owner('deployment') }, spec: { template: newTemplate } },
    { kind: 'Pod', metadata: { uid: 'old', ownerReferences: owner('rs-old') } },
    ...applied ? [] : [{ kind: 'Pod', metadata: { uid: 'new', ownerReferences: owner('rs-new') } }],
  ] };
  if (scenario === 'template-drift') newTemplate.spec.serviceAccountName = 'different';
  const deps = {
    store, namespace: 'octogee-test', chartFingerprint: 'chart', runExclusive: async (work: () => Promise<void>) => { events.push('exclusive'); await work(); },
    helm: { readDeployedInstance: async () => ({ image: { repository: 'reg/builder', tag: scenario === 'post-helm-crash' ? oldTag : newTag }, chartFingerprint: 'chart', deploymentIntentFingerprint: 'intent' }),
      upsertInstance: vi.fn(async () => { events.push('helm-old-artifact'); applied = true; }) },
    readRelease: async (_gatewayId: string, release: number) => release === 1 ? liveArtifact : installedArtifact,
    prepareIntent: async (_gateway: unknown, release: ReleasePayload) => ({ imageRepository: 'reg/builder', imageTag: release.imageTag, deploymentIntentFingerprint: 'intent', rollStrategy: 'surge', waitForReady: false }),
    listPods: async () => ({ pods: applied ? [retained] : [retained, target], observedPodUids: applied ? ['old'] : ['old', 'new'] }),
    readPodHealth: async () => health,
    holdTarget: async (request: unknown) => { events.push('hold'); if (scenario === 'hold-unavailable') { throw Error('old target lacks cleanup protocol'); } return request; },
    unreserveTarget: async () => { events.push('unreserve'); if (scenario === 'claim-during-cleanup') roll.startedAt = 3000; },
    readTemplateObjects: async () => objects, now: () => 5000, wait: async () => undefined, log: vi.fn(),
  } as unknown as Parameters<typeof createUserActivationRollRecoveryOwner>[0];
  const ctx = { reportStep: vi.fn(async () => undefined), assertActiveClaim: async () => { if (roll.startedAt !== 2000) throw Error('claim changed'); } };
  return { run: () => createUserActivationRollRecoveryOwner(deps)({ ...roll, startedAt: 2000 }, ctx), events, store, documents, operationId, recovery, assignment, lease, user, deps, ctx };
}

describe('rollout owner settles a held abandoned activation', () => {
  it('uses its rollout claim, keeps recovery pending and journals only after one retained predecessor remains', async () => {
    const h = fixture();
    await expect(h.run()).resolves.toMatchObject({ operationId: h.operationId, retainedPodUid: 'old', discardedPodUid: 'new', rollOperationId: 'roll-2', rollClaimStartedAt: 2000 });
    expect(h.events).toEqual(['exclusive', 'hold', 'unreserve', 'helm-old-artifact', 'journal-proof']);
    const current = await readUserActivationRollRecovery({ state: h.store, gatewayId: 'builder-a' });
    expect(current?.operation).toMatchObject({ status: 'pending', startedAt: null });
    expect(hasUserActivationTargetRollback(current!.operation)).toBe(true);
    expect(h.assignment).toMatchObject({ state: 'quiescing', epoch: 7 });
    expect(h.deps.helm.upsertInstance).toHaveBeenCalledWith(expect.objectContaining({ imageTag: expect.stringContaining('abc1234'), builderIdentity: { ownerUid: 'alice', builderSlug: 'alice' } }));
  });
  it('ends a held VM target rollout without Helm work so its exact pending source recovery can run', async () => {
    const h = fixture();
    h.documents.set('glmGateways/builder-a', runtimeDoc({ runtime: 'gce-vm', release: 1, vm: { instanceId: 'held-vm' } }));
    const readInstalled = vi.spyOn(h.deps.helm, 'readDeployedInstance');
    const error = await h.run().then(() => null, failure => failure as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain(`source recovery ${h.operationId}`);
    expect(classifyOperationFailure(error?.message)).toBe('terminal');
    expect(readInstalled).not.toHaveBeenCalled();
    expect(h.deps.helm.upsertInstance).not.toHaveBeenCalled();
    expect(h.events).toEqual(['exclusive']);
    expect(h.recovery).toMatchObject({ status: 'pending', startedAt: null });
    expect(h.assignment).toMatchObject({ state: 'quiescing', epoch: 7 });
  });

  it.each(['template-drift', 'hold-unavailable'])('keeps original target-repair behavior when predecessor proof is unavailable: %s', async scenario => {
    const h = fixture(scenario); await expect(h.run()).resolves.toBeNull();
    expect(h.events).not.toContain('helm-old-artifact'); expect(h.events).not.toContain('journal-proof'); expect(h.deps.log).toHaveBeenCalled();
  });
  it.each(['claim-during-cleanup', 'epoch-before-proof'])('does not journal proof after %s', async scenario => {
    const h = fixture(scenario); await expect(h.run()).rejects.toThrow(); expect(h.events).not.toContain('journal-proof');
  });
  it('does not use an arbitrary pending migration as an active cleanup claim', async () => {
    const h = fixture(); h.lease.generation++;
    await expect(h.run()).resolves.toBeNull(); expect(h.events).toEqual(['exclusive']);
  });
  it.each(['cluster', 'gce-vm'])('does not stop a %s roll after canonical Shared serving is restored', async runtime => {
    const h = fixture(); h.assignment.state = 'serving';
    h.documents.set('glmGateways/builder-a', runtimeDoc({ runtime, release: 2 }));
    await expect(h.run()).resolves.toBeNull(); expect(h.events).toEqual(['exclusive']);
  });
});

function requestThroughHandler(handle: (path: string, body: string) => Promise<{ status: number; body: unknown }>): SurgeControlRequest {
  return (options, onResponse) => {
    const request = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void; end: (body: string) => void };
    request.setTimeout = () => undefined; request.destroy = () => undefined;
    request.end = body => { void handle(String(options.path), body).then(response => {
      const incoming = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void };
      incoming.statusCode = response.status; incoming.setEncoding = () => undefined; onResponse(incoming);
      incoming.emit('data', JSON.stringify(response.body)); incoming.emit('end');
    }).catch(error => request.emit('error', error)); };
    return request;
  };
}

describe('retained predecessor recovery after a post-Helm crash', () => {
  it.each(['success', 'cleanup-unavailable'])('requires exact signed released-target cleanup before writing the missing proof: %s', async scenario => {
      const h = fixture('post-helm-crash'); let cleaned = 0;
      const request = requestThroughHandler(async (path, body) => {
        const parsed = JSON.parse(body);
        expect(parsed).toEqual({ migrationId: `mig-${h.operationId}`, slug: 'alice', targetPodUid: 'old', receivingPodUid: 'old' });
        if (path.startsWith('/hold-surge-openclaw/')) {
          return { status: 409, body: { error: 'OpenClaw process hold failed', message: 'surge OpenClaw process gate target migration already released' } };
        }
        expect(path).toBe('/unreserve-surge-openclaw/builder-a');
        if (scenario === 'cleanup-unavailable') return { status: 409, body: { error: 'OpenClaw process unreserve failed', message: 'Native cleanup unavailable' } };
        cleaned++; return { status: 200, body: { ...parsed, operation: 'unreserve', mode: 'held', phase: 'held', role: 'normal' } };
      });
      const transport = createSurgePodTransport({ privateKey: FLEET_KEY_PAIR.privateKey, request, log: vi.fn() });
      h.deps.holdTarget = transport.holdTargetOpenClaw!; h.deps.unreserveTarget = transport.unreserveTargetOpenClaw!;
      const outcome = await h.run();
      if (scenario === 'success') {
        expect(outcome).toMatchObject({ retainedPodUid: 'old', discardedPodUid: null });
        expect(cleaned).toBe(1); expect(h.events).toEqual(['exclusive', 'helm-old-artifact', 'journal-proof']);
      } else {
        expect(outcome).toBeNull(); expect(cleaned).toBe(0); expect(h.events).toEqual(['exclusive']);
      }
  });
});

describe('retained rollback proof fences the entire source-recovery custody period', () => {
  it('continues to defer after pending recovery is claimed and during cleanup, then ends only at canonical settlement', async () => {
    const { readUserActivationRollRecoveryCustody } = await import('../user-activation-roll-recovery.js');
    const h = fixture(); await h.run();
    const pending = await readUserActivationRollRecoveryCustody({ state: h.store, gatewayId: 'builder-a' });
    expect(hasUserActivationTargetRollback(pending!.operation, pending!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { status: 'running', startedAt: 6000 });
    expect(await readUserActivationRollRecovery({ state: h.store, gatewayId: 'builder-a' })).toBeNull();
    const claimed = await readUserActivationRollRecoveryCustody({ state: h.store, gatewayId: 'builder-a' });
    expect(hasUserActivationTargetRollback(claimed!.operation, claimed!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { steps: [{ name: 'recover-source', status: 'running' }] });
    (h.documents.get(`glmOperations/${h.operationId}`) as typeof h.recovery).schedulerHandoff.sourceRecovery.steps.push({ name: 'rollback:unmount-target', status: 'done' });
    const cleaning = await readUserActivationRollRecoveryCustody({ state: h.store, gatewayId: 'builder-a' });
    expect(hasUserActivationTargetRollback(cleaning!.operation, cleaning!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { status: 'failed', error: 'target cleanup transport interrupted' });
    const retrying = await readUserActivationRollRecoveryCustody({ state: h.store, gatewayId: 'builder-a' });
    expect(retrying).not.toBeNull();
    expect(hasUserActivationTargetRollback(retrying!.operation, retrying!.recovery)).toBe(true);
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { schedulerHandoffReleased: true });
    h.assignment.state = 'serving';
    delete (h.user.provisioning.openclaw as { migration?: unknown }).migration;
    expect(await readUserActivationRollRecoveryCustody({ state: h.store, gatewayId: 'builder-a' })).toBeNull();
  });
  it('retains the custody proof through normal failed completion and the existing source-recovery rearm owner', async () => {
    const h = fixture(); await h.run();
    Object.assign(h.documents.get(`glmOperations/${h.operationId}`) as object, { status: 'running', startedAt: 6000 });
    const operation = (await h.store.journal.operations.get(h.operationId))!;
    await h.store.journal.operations.patch(h.operationId, buildOperationCompletionUpdate({ op: operation, result: { success: false, steps: [], error: 'target cleanup refused' }, steps: [], now: 7000 }));
    const failed = (await h.store.journal.operations.get(h.operationId))!;
    expect(failed.status).toBe('failed');
    expect(hasUserActivationTargetRollback(failed)).toBe(true);
    expect(await rearmOwnedLegacyMigration({ store: h.store, operationId: h.operationId, now: 8000, admitted: () => true })).toBe(true);
    const current = await readUserActivationRollRecovery({ state: h.store, gatewayId: 'builder-a' });
    expect(current!.operation).toMatchObject({ status: 'pending', startedAt: null });
    expect(hasUserActivationTargetRollback(current!.operation, current!.recovery)).toBe(true);
  });
  it.each(['lease', 'generation', 'epoch'])('does not consume a rollback proof for another %s', async field => {
    const h = fixture(); await h.run();
    const current = await readUserActivationRollRecovery({ state: h.store, gatewayId: 'builder-a' });
    const expected = { ...current!.recovery };
    if (field === 'lease') expected.leaseId = 'different';
    if (field === 'generation') expected.generation++;
    if (field === 'epoch') expected.sourceEpoch++;
    expect(hasUserActivationTargetRollback(current!.operation, expected)).toBe(false);
  });
});
