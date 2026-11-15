import { describe, expect, it } from 'vitest';
import { createDocumentFixtureStore } from '@octogee/core/testing/journal-store';
import { qualifyUserActivationRollRecovery, type UserActivationRollRecoveryRecords } from '../user-activation-roll-recovery.js';

function fixture() {
  const migrationId = 'mig-builder-activate-builder-a-g1:scheduler:1:claim:1000';
  const gateway = { gatewayId: 'builder-a', gatewayClass: 'isolated', ownerUid: 'alice', builderSlug: 'alice', desiredStatus: 'running', liveRelease: 1, desiredRelease: 2, latestRelease: 2,
    allocation: { kind: 'disposable-builder', leaseId: 'lease-a', generation: 1, claimedByUid: 'alice' } };
  const operation = { id: 'builder-activate-builder-a-g1', kind: 'migrate-user', status: 'pending', startedAt: null,
    input: { uid: 'alice', userSlug: 'alice', source: 'builder-activation-lease', fromGatewayId: 'shared-a', toGatewayId: 'builder-a', recoverSourceOnly: true },
    schedulerHandoff: { uid: 'alice', slug: 'alice', migrationId, fromGatewayId: 'shared-a', toGatewayId: 'builder-a', stageAfterCutover: true,
      sourceRecovery: { migrationId, sourceEpoch: 7, steps: [{ name: 'quiesce-source', status: 'done' }] } } };
  const lease = { leaseId: 'lease-a', generation: 1, status: 'activating', sourceGatewayId: 'shared-a', sourceAssignmentEpoch: 7, targetGatewayId: 'builder-a' };
  const user = { username: 'alice', provisioning: { openclaw: { gatewayId: 'shared-a', slug: 'alice', activationLease: lease, migration: { state: 'moving', operationId: operation.id, startedAt: 1000 } } } };
  const sourceRoot = { gatewayId: 'shared-a', gatewayClass: 'shared', desiredStatus: 'running', desiredRelease: 3, latestRelease: 3 };
  const sourceAssignment = { uid: 'alice', slug: 'alice', gatewayId: 'shared-a', source: 'migrate-user', state: 'quiescing', epoch: 7, updatedByOperationId: operation.id };
  const snapshot = { gateway, operation, user, sourceRoot, sourceAssignment, targetOccupied: false };
  return { snapshot, gateway, operation, user, lease, sourceRoot, sourceAssignment };
}

async function records(h: ReturnType<typeof fixture>): Promise<UserActivationRollRecoveryRecords> {
  const store = createDocumentFixtureStore({
    'gateways/builder-a': h.gateway, [`glmOperations/${h.operation.id}`]: h.operation, 'users/alice': h.user,
    'gateways/shared-a': h.sourceRoot, 'gateways/shared-a/assignments/alice': h.sourceAssignment,
  });
  const [gateway, operation, userRecord, sourceRoot, sourceAssignment] = await Promise.all([
    store.gateways.roots.get('builder-a'), store.journal.operations.get(h.operation.id), store.users.records.get('alice'),
    store.gateways.roots.get('shared-a'), store.gateways.assignments.get('shared-a', 'alice'),
  ]);
  return { gateway: gateway!, operation: operation!, user: userRecord, sourceRoot, sourceAssignment, targetOccupied: h.snapshot.targetOccupied };
}

describe('unadmitted user activation rollout recovery authority', () => {
  it('recognizes a pending recovery without inventing an active migration claim', async () => {
    const h = fixture();
    expect(qualifyUserActivationRollRecovery(await records(h))).toMatchObject({ uid: 'alice', sourceEpoch: 7, generation: 1, operationId: h.operation.id });
    expect(h.operation.startedAt).toBeNull();
  });
  it.each([
    ['another target owner', (h: ReturnType<typeof fixture>) => { h.gateway.ownerUid = 'other'; }],
    ['another allocation generation', (h: ReturnType<typeof fixture>) => { h.gateway.allocation.generation = 2; }],
    ['another lease', (h: ReturnType<typeof fixture>) => { h.lease.leaseId = 'other'; }],
    ['another source epoch', (h: ReturnType<typeof fixture>) => { h.sourceAssignment.epoch++; }],
    ['a serving source', (h: ReturnType<typeof fixture>) => { h.sourceAssignment.state = 'serving'; }],
    ['another marker', (h: ReturnType<typeof fixture>) => { h.user.provisioning.openclaw.migration.operationId = 'other'; }],
    ['a running recovery', (h: ReturnType<typeof fixture>) => { h.operation.status = 'running'; }],
    ['an occupied target', (h: ReturnType<typeof fixture>) => { h.snapshot.targetOccupied = true; }],
    ['an active lease', (h: ReturnType<typeof fixture>) => { h.lease.status = 'active'; }],
    ['a committed scheduler stage', (h: ReturnType<typeof fixture>) => { Object.assign(h.operation.schedulerHandoff, { stagedAt: 2000 }); }],
    ['a cutover', (h: ReturnType<typeof fixture>) => { Object.assign(h.operation, { cutoverCommittedAt: 2000 }); }],
    ['another handoff claim', (h: ReturnType<typeof fixture>) => { h.operation.schedulerHandoff.sourceRecovery.migrationId += '-other'; }],
    ['an unresolved runtime restart', (h: ReturnType<typeof fixture>) => { Object.assign(h.gateway, { runtimeRestartFence: {} }); }],
  ])('does not authorize rollback for %s', async (_name, change) => {
    const h = fixture(); change(h); expect(qualifyUserActivationRollRecovery(await records(h))).toBeNull();
  });
});

describe('owned held activation target rollback', () => {
  async function setup(scenario: string) {
    const { rollbackHeldUserActivationTarget } = await import('../user-activation-roll-recovery.js');
    const current = qualifyUserActivationRollRecovery(await records(fixture()))!;
    const events: string[] = []; let applied = false, cleaned = false, reads = 0, now = 0, proof: unknown;
    const liveImage = 'registry/builder:old@sha256:' + 'a'.repeat(64), installedImage = 'registry/builder:new@sha256:' + 'b'.repeat(64);
    const retained = { uid: 'old', name: 'pod-old', podIP: '10.0.0.1', image: liveImage, ready: false, terminating: false, crashLooping: false };
    const replacement = { ...retained, uid: 'new', name: 'pod-new', podIP: '10.0.0.2', image: installedImage };
    const health = { status: 'booting' as const, version: 'old', fleetSignatureCapability: 'gateway-scoped' as const, handoffReleased: false, prelaunchState: 'held' as const, mountedCustomers: [] as string[], migratingIn: [] as string[] };
    const result = rollbackHeldUserActivationTarget({ liveImage, installedImage, rollOperationId: 'roll-2', rollClaimStartedAt: 2000, timeoutMs: 3000,
      deps: {
        assertTemplateRollback: async () => { if (scenario === 'template-drift') throw Error('template drift'); },
        assertRollClaim: async () => { if (scenario === 'claim-before-cleanup' && reads > 0 || scenario === 'claim-after-cleanup' && cleaned || scenario === 'claim-after-helm' && applied) { throw Error('roll claim changed'); } },
        readCurrent: async () => scenario === 'no-recovery' ? null : scenario === 'epoch-after-cleanup' && cleaned ? { ...current, sourceEpoch: 8 } : current,
        observe: async () => {
          reads++;
          const old = scenario === 'replaced-before-cleanup' && reads > 1 ? { ...retained, uid: 'other-old' } : scenario === 'lost-predecessor-after-helm' && applied ? { ...retained, uid: 'other-old' } : retained;
          const pods = applied && scenario !== 'two-pods-timeout' ? [old] : [old, replacement];
          const states = new Map(pods.map(pod => [pod.uid, { ...health }]));
          if (scenario === 'foreign-mount') states.get(old.uid)!.mountedCustomers = ['other'];
          if (scenario === 'foreign-import') states.get(old.uid)!.migratingIn = ['other'];
          if (scenario === 'missing-import-evidence') delete (states.get(old.uid) as { migratingIn?: string[] }).migratingIn;
          if (scenario === 'running-native') Object.assign(states.get(old.uid)!, { status: 'ready' });
          if (scenario === 'legacy-control') Object.assign(states.get(old.uid)!, { fleetSignatureCapability: 'legacy' });
          if (scenario === 'released-readiness') states.get(old.uid)!.handoffReleased = true;
          if (scenario === 'cleanup-left-import' && cleaned) states.get(old.uid)!.migratingIn = ['alice'];
          return { pods, observedPodUids: pods.map(pod => pod.uid), health: states };
        },
        cleanupRetained: async () => { events.push('cleanup'); if (scenario === 'old-cleanup-unavailable') { throw Error('old target cleanup unavailable'); } cleaned = true; },
        applyLiveArtifact: async () => { events.push('helm-live-artifact'); applied = true; },
        recordProof: async value => { events.push('proof'); proof = value; },
        now: () => now, wait: async () => { now += 1000; },
      } });
    return { result, events, getProof: () => proof };
  }
  it('cleans the exact retained target, rolls back through Helm and waits for one allocation before recording proof', async () => {
    const h = await setup('success');
    await expect(h.result).resolves.toMatchObject({ retainedPodUid: 'old', discardedPodUid: 'new', sourceEpoch: 7, rollOperationId: 'roll-2', rollClaimStartedAt: 2000 });
    expect(h.events).toEqual(['cleanup', 'helm-live-artifact', 'proof']);
  });
  it.each(['no-recovery', 'foreign-mount', 'foreign-import', 'missing-import-evidence', 'running-native', 'legacy-control', 'released-readiness'])('does not mutate an unqualified %s target', async scenario => {
    const h = await setup(scenario); await expect(h.result).resolves.toBeNull(); expect(h.events).toEqual([]);
  });
  it.each(['claim-before-cleanup', 'replaced-before-cleanup', 'old-cleanup-unavailable', 'claim-after-cleanup', 'epoch-after-cleanup', 'cleanup-left-import', 'claim-after-helm', 'lost-predecessor-after-helm', 'two-pods-timeout', 'template-drift'])('keeps rollback fenced after %s', async scenario => {
    const h = await setup(scenario); await expect(h.result).rejects.toThrow(); expect(h.getProof()).toBeUndefined();
    if (['claim-before-cleanup', 'replaced-before-cleanup', 'template-drift'].includes(scenario)) expect(h.events).toEqual([]);
    if (['old-cleanup-unavailable', 'claim-after-cleanup', 'epoch-after-cleanup', 'cleanup-left-import'].includes(scenario)) expect(h.events).toEqual(['cleanup']);
  });
});

describe('immutable artifact rollback preserves the actual predecessor PodTemplate', () => {
  async function check(change?: (input: { predecessorTemplate: Record<string, unknown>; installedTemplate: Record<string, unknown>; chartFingerprint: string; installedIntentFingerprint: string }) => void) {
    const { heldIsolatedRollbackTemplatesMatch } = await import('../user-activation-roll-recovery.js');
    const oldTag = 'abc1234-oc2026@sha256:' + 'a'.repeat(64), newTag = 'def1234-oc2026@sha256:' + 'b'.repeat(64);
    const liveImage = { gateway: 'reg/gateway:' + oldTag, edge: 'reg/edge:abc@sha256:' + 'c'.repeat(64), tag: oldTag };
    const installedImage = { gateway: 'reg/gateway:' + newTag, edge: 'reg/edge:def@sha256:' + 'd'.repeat(64), tag: newTag };
    const predecessorTemplate = { metadata: { labels: { 'gateway-image': 'abc1234', 'pod-template-hash': 'oldhash', tenant: 'alice' } }, spec: { serviceAccountName: 'alice-sa', initContainers: [{ name: 'fix-perms', image: liveImage.gateway }], containers: [{ name: 'gateway', image: liveImage.gateway, env: [{ name: 'GATEWAY_IMAGE_TAG', value: oldTag }, { name: 'BUILDER_UID', value: 'alice' }] }, { name: 'gateway-edge', image: liveImage.edge }] } };
    const installedTemplate = structuredClone(predecessorTemplate);
    installedTemplate.metadata.labels['gateway-image'] = 'def1234'; installedTemplate.metadata.labels['pod-template-hash'] = 'newhash';
    installedTemplate.spec.initContainers[0].image = installedImage.gateway;
    installedTemplate.spec.containers[0].image = installedImage.gateway; installedTemplate.spec.containers[0].env![0].value = newTag;
    installedTemplate.spec.containers[1].image = installedImage.edge;
    const input = { predecessorTemplate, installedTemplate, liveImage, installedImage, chartFingerprint: 'chart-1', installedChartFingerprint: 'chart-1', reconstructedIntentFingerprint: 'intent-1', installedIntentFingerprint: 'intent-1' };
    change?.(input); return heldIsolatedRollbackTemplatesMatch(input);
  }
  it('permits only immutable image, image-tag environment and chart-derived image-label substitutions', async () => { expect(await check()).toBe(true); });
  it.each(['chart', 'intent', 'service-account', 'tenant', 'extra-env', 'init-image', 'annotation'])('refuses %s drift before any Helm mutation', async scenario => {
    expect(await check(input => {
      if (scenario === 'chart') input.chartFingerprint = 'other';
      if (scenario === 'intent') input.installedIntentFingerprint = 'other';
      const template = input.installedTemplate as { metadata: Record<string, unknown>; spec: { serviceAccountName: string; containers: Array<{ env?: Array<{ name: string; value: string }> }>; initContainers: Array<{ image: string }> } };
      if (scenario === 'service-account') template.spec.serviceAccountName = 'other';
      if (scenario === 'tenant') template.spec.containers[0].env![1].value = 'other';
      if (scenario === 'extra-env') template.spec.containers[0].env!.push({ name: 'EXTRA', value: '1' });
      if (scenario === 'init-image') template.spec.initContainers[0].image = 'other';
      if (scenario === 'annotation') template.metadata.annotations = { change: 'yes' };
    })).toBe(false);
  });
});
