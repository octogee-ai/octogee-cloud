import { enqueuePlacementMigration, continuousPlacementMigrationOperationId } from '../placement-policy-reconciler.js';
import { createRestartGatewayHandler } from '../handlers/restart-gateway.js';
import { MAX_OPERATION_ATTEMPT_HISTORY } from '../operation-retry.js';
import { assertSharedSourceRecoveryPredecessor, readSharedSourceRecoveryAuthority } from "@octogee/core/shared-source-recovery";
import { recoverSharedSourceRuntime } from "../lib/shared-source-runtime.js";
import { describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { acknowledgeUserRestore, beginUserRestore, type FleetStateDeps } from '@octogee/core/fleet-state';
import { createDocumentFixtureStore } from '@octogee/core/testing/journal-store';
import { MalformedRecordError } from '@octogee/core/platform-state';
import type { Operation } from '@octogee/shared/types/glm';
import { releasePayloadHash } from '@octogee/shared/types/gateway-releases';
import { recoverSharedRestoreRuntime } from '../lib/shared-restore-runtime.js';
import { processOperation } from '../index.js';
import { releaseAbandonedSchedulerHandoffs } from '../scheduler-handoff-release.js';
import { createRsyncMigrationTransfer } from '../lib/migration-rsync-transfer.js';

const sha = 'a'.repeat(40);
const images = { gateway: `us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway:aaaaaaa@sha256:${'b'.repeat(64)}`,
  'gateway-edge': `us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:aaaaaaa@sha256:${'c'.repeat(64)}` };
function harness() {
  const intent = { uid: 'u', slug: 'alice', gatewayId: 'shared-1', fromGatewayId: 'builder-alice', operationId: 'return',
    assignmentEpoch: 3, phase: 'dispatched', attemptId: 'original', claimStartedAt: 100, dispatchedAt: 100 };
  const op = { id: 'recover', kind: 'restart-gateway', status: 'running', startedAt: 300,
    input: { gatewayId: 'shared-1', restoreRecovery: { sourceSha: sha, operationId: 'return', images } }, steps: [] } as unknown as Operation;
  const store: Record<string, any> = {
    'gateways/shared-1': { gatewayId: 'shared-1', createdAt: 1, createdBy: 'test', updatedAt: 1, updatedBy: 'test', latestRelease: 1,
      desiredRelease: 1, liveRelease: 1, desiredStatus: 'running', configSchemaVersion: 1, profile: 'standard', gatewayClass: 'shared',
      imageProfile: 'standard', sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
      serviceAccount: null, builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null },
    'glmOperations/recover': structuredClone(op),
    'glmOperations/return': { kind: 'migrate-user', status: 'pending', input: { uid: 'u', fromGatewayId: 'builder-alice', toGatewayId: 'shared-1' },
      cutoverCommittedAt: 50, schedulerHandoff: { uid: 'u', slug: 'alice', fromGatewayId: 'builder-alice', toGatewayId: 'shared-1' }, restoreAttempt: intent },
    'users/u': { username: 'alice', provisioning: { status: 'complete', openclaw: { gatewayId: 'shared-1', status: 'complete', restoreFence: structuredClone(intent) } } },
    'gateways/shared-1/assignments/u': { uid: 'u', slug: 'alice', gatewayId: 'shared-1', source: 'onboarding', epoch: 3, state: 'serving' },
  };
  const value = (row: any, key: string) => key.split('.').reduce((current, part) => current?.[part], row);
  let autoId = 0;
  const ref = (path: string, filters: any[] = []): any => ({ path, id: path.split('/').at(-1), filters, get: async () => snapshot({ path, filters }),
    doc: (id = `generated-${++autoId}`) => ref(`${path}/${id}`), collection: (name: string) => ref(`${path}/${name}`),
    where: (key: string, comparator: string, match: unknown) => ref(path, [...filters, { key, comparator, match }]) });
  const snapshot = (target: any): any => {
    const updateTime = (row: any) => { const version = JSON.stringify(row); return { version, isEqual: (other: any) => version === other?.version }; };
    if (target.path.split('/').length % 2 === 0) return { exists: !!store[target.path], data: () => store[target.path], updateTime: updateTime(store[target.path]) };
    return { docs: Object.entries(store).filter(([path, row]) => path.startsWith(`${target.path}/`) && !path.slice(target.path.length + 1).includes('/') &&
      target.filters.every((filter: any) => filter.comparator === 'in' ? filter.match.includes(value(row, filter.key)) : value(row, filter.key) === filter.match))
      .map(([path, row]) => ({ id: path.split('/').at(-1), ref: ref(path), updateTime: updateTime(row), data: () => row })) };
  };
  const db = { doc: ref, collection: ref, runTransaction: async (body: any) => {
    const writes: (() => void)[] = [];
    const result = await body({ get: async (target: any) => snapshot(target), set: (target: any, row: any) => writes.push(() => { store[target.path] = structuredClone(row); }), create: (target: any, row: any) => writes.push(() => { expect(store[target.path]).toBeUndefined(); store[target.path] = structuredClone(row); }), update: (target: any, patch: any) => writes.push(() => {
      for (const [key, val] of Object.entries(patch)) {
        const parts = key.split('.'); let row = store[target.path];
        for (const part of parts.slice(0, -1)) row = row[part] ??= {};
        if (val instanceof FieldValue && val.isEqual(FieldValue.delete())) delete row[parts.at(-1)!];
        else row[parts.at(-1)!] = structuredClone(val);
      }
    }) });
    writes.forEach(write => write()); return result;
  } };
  const pod: any = { metadata: { name: 'pod', uid: 'pod-uid', resourceVersion: 'rv', labels: { 'gateway-instance': 'shared-1' },
    ownerReferences: [{ controller: true, kind: 'ReplicaSet', name: 'rs', uid: 'rs-uid' }] },
    spec: { volumes: [{ name: 'data', emptyDir: {} }], containers: Object.keys(images).map(name => ({ name, image: `old-${name}`,
      volumeMounts: [{ name: 'data', mountPath: '/home/node' }] })) }, status: { phase: 'Running', conditions: [], containerStatuses: [] } };
  let lostReply = false;
  let ready = true;
  const runKubectl = vi.fn(async (args: string[]) => {
    if (args.includes('patch')) {
      const fence = store['gateways/shared-1'].runtimeRestartFence;
      expect(fence.phase).toBe('dispatched'); expect(store['users/u'].provisioning.openclaw.restoreFence).toEqual(intent);
      const patch = JSON.parse(args[args.indexOf('-p') + 1]);
      expect(patch.slice(0, 2)).toEqual([{ op: 'test', path: '/metadata/uid', value: 'pod-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: 'rv' }]);
      expect(patch.filter((item: any) => item.op === 'replace').every((item: any) => /^\/spec\/containers\/\d\/image$/.test(item.path))).toBe(true);
      for (const replacement of patch.filter((item: any) => item.op === 'replace')) {
        const index = Number(replacement.path.split('/')[3]);
        pod.spec.containers[index].image = replacement.value;
      }
      pod.status.conditions = [{ type: 'Ready', status: ready ? 'True' : 'False' }];
      pod.status.containerStatuses = pod.spec.containers.map(({ name, image }: any) => ({ name, ready, imageID: image }));
      if (lostReply) return { code: 1, stdout: '', stderr: 'lost reply' };
    }
    const result = args.includes('pods') ? { items: [pod] } : args.includes('replicaset') ?
      { metadata: { uid: 'rs-uid', ownerReferences: [{ controller: true, kind: 'Deployment', uid: 'deployment-uid' }] } } :
      args.includes('deployment') ? { metadata: { uid: 'deployment-uid' } } : pod;
    return { code: 0, stdout: JSON.stringify(result), stderr: '' };
  });
  const ctx = { assertActiveClaim: vi.fn(async () => {}), reportStep: vi.fn() };
  const deps = { store: createDocumentFixtureStore(store), namespace: 'octogee-test', sourceSha: sha, runKubectl };
  return { deps, db: db as never, op, ctx, store, pod, lostReply: () => { lostReply = true; }, setReady: (value: boolean) => { ready = value; } };
}
describe('journaled Shared restore runtime recovery', () => {
  function reauthorize(h: ReturnType<typeof harness>) {
    const original = h.store['glmOperations/return'].restoreAttempt;
    original.claimStartedAt = 200;
    h.store['users/u'].provisioning.openclaw.restoreFence = structuredClone(original);
    h.op.input.restoreRecovery = { ...h.op.input.restoreRecovery as object, reauthorize: structuredClone(original) };
    h.store['glmOperations/recover'].input = structuredClone(h.op.input);
    return structuredClone(original);
  }
  async function failedRecovery() {
    const h = harness();
    const intent = reauthorize(h);
    h.setReady(false);
    let clock = 1;
    await expect(recoverSharedRestoreRuntime({ ...h.deps, now: () => clock, wait: async () => { clock += 240_000; } }, h.op, h.ctx))
      .rejects.toThrow('restore recovery images are not ready; outcome remains fenced');
    Object.assign(h.store['glmOperations/recover'], { status: 'failed', completedAt: 500, error: 'restore recovery images are not ready; outcome remains fenced' });
    const predecessor = { operationId: 'recover', input: structuredClone(h.op.input), completedAt: 500,
      fence: structuredClone(h.store['gateways/shared-1'].runtimeRestartFence) };
    const nextSha = 'd'.repeat(40);
    const nextImages = Object.fromEntries(Object.entries(images).map(([name, image]) => [name,
      image.replace('aaaaaaa', 'ddddddd').replace(/@sha256:.+$/, `@sha256:${'e'.repeat(64)}`)]));
    const next = { ...h.op, id: 'successor', startedAt: 600, input: { gatewayId: 'shared-1',
      restoreRecovery: { operationId: 'return', sourceSha: nextSha, images: nextImages, reauthorize: intent, supersede: predecessor } } } as Operation;
    h.store['glmOperations/successor'] = structuredClone(next);
    h.deps.runKubectl.mockClear();
    h.setReady(true);
    return { h, next, deps: { ...h.deps, sourceSha: nextSha }, predecessor, intent, nextImages };
  }
  it('keeps explicit reauthorization mandatory for a failed predecessor even when its prior request omitted it', async () => {
    const { h, next, deps } = await failedRecovery();
    delete (next.input.restoreRecovery as any).reauthorize;
    delete (h.store['glmOperations/recover'].input.restoreRecovery as any).reauthorize;
    delete (next.input.restoreRecovery as any).supersede.input.restoreRecovery.reauthorize;
    h.store['glmOperations/successor'].input = structuredClone(next.input);
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  function queuedMigration(h: ReturnType<typeof harness>) {
    h.store['glmOperations/queued'] = { kind: 'migrate-user', status: 'pending', createdAt: 1_000,
      createdBy: 'glm-controller-placement-policy', origin: 'automatic', startedAt: null, completedAt: null,
      input: { uid: 'other', fromGatewayId: 'shared-1', toGatewayId: 'builder-other' }, steps: [] };
    const handler = vi.fn(async () => ({ success: true, steps: [] }));
    const log = vi.fn();
    const run = () => processOperation({ ...h.store['glmOperations/queued'], id: 'queued' },
      { store: h.deps.store, handlers: { 'migrate-user': handler }, log } as never);
    return { run, handler, log };
  }

  function blockedPreTransportMigration(h: ReturnType<typeof harness>, attempts = 13) {
    const queued = queuedMigration(h);
    const row = h.store['glmOperations/queued'];
    const error = 'expected exactly one ready pod for transport=shared-1; found 0';
    row.input = { uid: 'other', userSlug: 'bob', fromGatewayId: 'shared-1', toGatewayId: 'shared-2' };
    Object.assign(row, { attempts, firstStartedAt: 1_100, lastProgressAt: 1_200 + attempts * 100, nextAttemptAt: 481_200 + attempts * 100,
      error: `attempt ${attempts} failed (transient): ${error} — retrying in 480s`,
      schedulerHandoff: { uid: 'other', slug: 'bob', fromGatewayId: 'shared-1', toGatewayId: 'shared-2', migrationId: `mig-queued:scheduler:${attempts}:claim:${1_100 + (attempts - 1) * 100}` },
      schedulerHandoffReleased: false, attemptHistory: Array.from({ length: attempts }, (_, index) => ({
        attempt: index + 1, startedAt: 1_100 + index * 100, completedAt: 1_200 + index * 100,
        error, classification: 'transient', steps: [{ name: 'keys-sync-state', status: 'failed', error }],
      })).slice(-MAX_OPERATION_ATTEMPT_HISTORY) });
    h.store['users/other'] = { provisioning: { openclaw: { status: 'complete', gatewayId: 'shared-1',
      migration: { operationId: 'queued', phase: 'preparing', state: 'preparing', startedAt: 1_100 } } } };
    h.store['gateways/shared-1/assignments/other'] = { uid: 'other', slug: 'bob', gatewayId: 'shared-1', source: 'migrate-user', state: 'serving', epoch: 0, updatedByOperationId: null };
    const scheduler = vi.fn(async () => { throw new Error('no scheduler RPC is safe while the source is unavailable'); });
    const release = () => releaseAbandonedSchedulerHandoffs({ store: h.deps.store, scheduler,
      gatewayExists: vi.fn(async () => false), log: vi.fn(), now: () => Math.max(3_000, 1_300 + attempts * 100) });
    return { ...queued, release, scheduler, get row() { return h.store['glmOperations/queued']; } };
  }

  it('releases a proven pre-transport retry through its owner before admitting same-pod restore recovery', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(before);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(queued.row).toEqual({ ...before['glmOperations/queued'], schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const released = structuredClone(queued.row);
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      if (args.includes('patch')) {
        await queued.run();
        expect(queued.handler).not.toHaveBeenCalled();
        expect(queued.row).toEqual(released);
      }
      return kubectl(args);
    });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(queued.row).toEqual(released);
    expect(h.store['users/other']).toEqual(before['users/other']);
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(before['gateways/shared-1/assignments/other']);
    expect(h.store['glmOperations/return']).toEqual(before['glmOperations/return']);
    expect(h.store['users/u']).toEqual(before['users/u']);
  });

  it.each([1, 5, 282])('recovers a repeated Shared placement with serving epoch %s and a prior operation owner', async epoch => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    Object.assign(h.store['gateways/shared-1/assignments/other'], { epoch, updatedByOperationId: 'completed-prior-shared-move' });
    const assignment = structuredClone(h.store['gateways/shared-1/assignments/other']);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(assignment);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it.each([21, 37])('recovers after attempt %s with the complete retained contiguous suffix ending at its current handoff', async attempts => {
    const h = harness(); const queued = blockedPreTransportMigration(h, attempts);
    const history = structuredClone(queued.row.attemptHistory);
    expect(history).toHaveLength(MAX_OPERATION_ATTEMPT_HISTORY); expect(history[0].attempt).toBe(attempts - MAX_OPERATION_ATTEMPT_HISTORY + 1);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled(); expect(queued.row.attemptHistory).toEqual(history);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it('recovers a retained two-pod selector failure followed by the current zero-pod failure', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const prior = queued.row.attemptHistory[0];
    prior.error = prior.steps[0].error = 'expected exactly one ready pod for transport=shared-1; found 2';
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(queued.row.attemptHistory).toEqual(before['glmOperations/queued'].attemptHistory);
    expect(h.store['users/other']).toEqual(before['users/other']);
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(before['gateways/shared-1/assignments/other']);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it('releases the captured provisioning owner without completing it or changing its preparing migration custody', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 25);
    const owner = h.store['users/other'].provisioning.openclaw;
    owner.status = 'provisioning'; owner.migration.startedAt = 1_791_942_726_854;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(queued.scheduler).not.toHaveBeenCalled();
    expect(h.store['users/other']).toEqual(before['users/other']);
    expect(h.store['gateways/shared-1/assignments/other']).toEqual(before['gateways/shared-1/assignments/other']);
    expect(h.store['gateways/shared-2/assignments/other']).toBeUndefined();
    expect(h.store['glmOperations/queued'].attemptHistory).toEqual(before['glmOperations/queued'].attemptHistory);
    expect(h.store['glmOperations/return']).toEqual(before['glmOperations/return']);
    expect(h.store['users/u']).toEqual(before['users/u']);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });

  it.each(['unknown', 'error', undefined])('denies an unrecognized lifecycle owner status %j', async status => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 25);
    h.store['users/other'].provisioning.openclaw.status = status;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before);
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 4_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('does not release a provisioning owner whose preparing marker belongs to another operation', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 25);
    Object.assign(h.store['users/other'].provisioning.openclaw, { status: 'provisioning',
      migration: { state: 'preparing', phase: 'preparing', operationId: 'another-move', startedAt: 1_791_942_726_854 } });
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 4_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([
    'expected exactly one ready pod for transport=shared-1; found 1',
    'expected exactly one ready pod for transport=shared-1; found -1',
    'expected exactly one ready pod for transport=shared-1; found 2.5',
    'expected exactly one ready pod for transport=shared-1; found 02',
    'expected exactly one ready pod for transport=shared-1; found 1e1',
    'expected exactly one ready pod for transport=shared-1; found unknown',
    'expected exactly one ready pod for transport=shared-1; found 2; socket closed',
    'expected exactly one ready pod for transport=shared-2; found 2',
    'expected exactly one running pod for transport=shared-1; found 2',
    'socket closed before connect response',
  ])('denies prior keys failures outside the exact same-source pod-selector contract: %s', async error => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const prior = queued.row.attemptHistory[0]; prior.error = prior.steps[0].error = error;
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('requires the latest selector failure to remain zero even after a known earlier two-pod failure', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    for (const attempt of queued.row.attemptHistory) {
      attempt.error = attempt.steps[0].error = 'expected exactly one ready pod for transport=shared-1; found 2';
    }
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([0, 2])('fails actual source pod selection at cardinality %s before gateway RPC or guest execution', async count => {
    const tasks: Record<string, Record<string, unknown>> = {};
    const fetch = vi.fn(async () => { throw new Error('gateway RPC must not run before source selection'); });
    const resolveGatewayUrl = vi.fn(() => { throw new Error('gateway control URL must not be used before source selection'); });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('kubectl'); expect(args.slice(0, 4)).toEqual(['-n', 'octogee-test', 'get', 'pods']);
      const source = args[args.indexOf('-l') + 1].endsWith('gateway-instance=shared-1');
      return { code: 0, stderr: '', stdout: JSON.stringify({ items: Array.from({ length: source ? count : 1 }, (_, index) => ({
        metadata: { name: `pod-${index}` }, status: { phase: 'Running', podIP: `10.0.0.${index + 1}`, conditions: [{ type: 'Ready', status: 'True' }] },
      })) }) };
    });
    const transfer = createRsyncMigrationTransfer({ store: createDocumentFixtureStore(tasks), namespace: 'octogee-test',
      privateKey: 'unused-before-gateway-rpc', fleetControllerPort: '3003', fetch, resolveGatewayUrl, runCommand });
    await expect(transfer({ migrationId: 'mig-queued', slug: 'bob', fromGatewayId: 'shared-1', toGatewayId: 'shared-2', mode: 'keys' }))
      .rejects.toMatchObject({ message: `expected exactly one ready pod for transport=shared-1; found ${count}`, retryable: true });
    expect(fetch).not.toHaveBeenCalled(); expect(resolveGatewayUrl).not.toHaveBeenCalled(); expect(runCommand).toHaveBeenCalledTimes(2);
    expect(tasks['glmMigrationTransferTasks/mig-queued__keys']).toMatchObject({ status: 'failed', error: `expected exactly one ready pod for transport=shared-1; found ${count}` });
  });

  it.each(['short-suffix', 'gap', 'duplicate', 'unknown-attempt', 'wrong-latest', 'stale-handoff', 'retained-hold', 'unknown-steps'])('denies capped history with %s', async change => {
    const h = harness(); const queued = blockedPreTransportMigration(h, 37);
    const history = queued.row.attemptHistory;
    if (change === 'short-suffix') history.shift();
    if (change === 'gap') history[4].attempt += 1;
    if (change === 'duplicate') history[4].attempt = history[3].attempt;
    if (change === 'unknown-attempt') delete history[4].attempt;
    if (change === 'wrong-latest') history.at(-1).attempt -= 1;
    if (change === 'stale-handoff') queued.row.schedulerHandoff.migrationId = 'mig-queued:scheduler:36';
    if (change === 'retained-hold') history[0].steps.push({ name: 'quiesce-source', status: 'done' });
    if (change === 'unknown-steps') delete history.at(-1).steps;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 5_000 });
    const released = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(released);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([-1, 1.5, '2', undefined, Number.NaN])('denies a noncanonical source epoch %j', async epoch => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    h.store['gateways/shared-1/assignments/other'].epoch = epoch;
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toBeInstanceOf(MalformedRecordError);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('denies a source assignment already owned by the current attempted migration', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    h.store['gateways/shared-1/assignments/other'].updatedByOperationId = 'queued';
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each([
    ['startedAt', 2_600], ['status', 'running'], ['completedAt', 2_600], ['steps', [{ name: 'keys-sync-state', status: 'running' }]],
    ['attempts', 14], ['attemptHistory', undefined], ['attemptHistory', []], ['resumeCount', 1], ['lastResumedAt', 2_500],
    ['userMigrationV2', {}], ['sourceTransferExecution', {}], ['schedulerHandoffLost', true], ['cutoverCommittedAt', 2_000],
    ['restoreAttempt', {}], ['cancellationRequestedAt', 2_000], ['rolledBack', false], ['output', { configCleanup: {} }],
    ['input.toGatewayId', 'builder-other'], ['input.sourceTransferMode', 'retained-pod'],
    ['input.recoverSourceOnly', true], ['schedulerHandoff.migrationId', 'mig-queued:scheduler:12'], ['schedulerHandoff.uid', 'foreign'],
    ['schedulerHandoff.slug', 'foreign'], ['schedulerHandoff.fromGatewayId', 'shared-foreign'], ['schedulerHandoff.toGatewayId', 'shared-foreign'],
    ['schedulerHandoff.stageAfterCutover', true], ['schedulerHandoff.stagedAt', 2_000], ['schedulerHandoff.sourceRecovery', {}],
    ['attemptHistory.0.steps', [{ name: 'quiesce-source', status: 'done' }]], ['attemptHistory.12.classification', 'terminal'],
    ['attemptHistory.12.steps.0.status', 'running'], ['attemptHistory.12.steps.0.error', 'socket closed before connect response'],
    ['attemptHistory.12.error', 'expected exactly one ready pod for transport=shared-2; found 0'],
  ])('keeps attempted or ambiguous queued work fenced at %s=%j', async (path, value) => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const parts = (path as string).split('.');
    const target = parts.slice(0, -1).reduce((row, key) => row[key], queued.row);
    target[parts.at(-1)!] = value;
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const released = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(released);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it.each(['owner', 'marker', 'phase', 'restore-fence', 'transfer-fence', 'source-missing', 'source-uid', 'source-slug',
    'source-gateway', 'source-state', 'source-epoch', 'source-operation', 'target-assignment'])('refuses pre-transport release and recovery after %s changes', async change => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const owner = h.store['users/other'].provisioning.openclaw;
    const source = h.store['gateways/shared-1/assignments/other'];
    if (change === 'owner') owner.gatewayId = 'shared-2';
    if (change === 'marker') owner.migration.operationId = 'foreign';
    if (change === 'phase') owner.migration.phase = 'transferring';
    if (change === 'restore-fence') owner.restoreFence = {};
    if (change === 'transfer-fence') owner.sourceTransferFence = { sourceGatewayId: 'shared-1' };
    if (change === 'source-missing') delete h.store['gateways/shared-1/assignments/other'];
    if (change === 'source-uid') source.uid = 'foreign';
    if (change === 'source-slug') source.slug = 'foreign';
    if (change === 'source-gateway') source.gatewayId = 'shared-2';
    if (change === 'source-state') source.state = 'quiescing';
    if (change === 'source-epoch') source.epoch = -1;
    if (change === 'source-operation') source.updatedByOperationId = {};
    if (change === 'target-assignment') h.store['gateways/shared-2/assignments/other'] = { ...source, gatewayId: 'shared-2' };
    const before = structuredClone(h.store);
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(h.store).toEqual(before); expect(queued.scheduler).not.toHaveBeenCalled();
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    const released = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(released);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('does not release a migration claimed after the scheduler sweep snapshot', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    const store = h.deps.store, transaction = store.transaction.bind(store);
    vi.spyOn(store, 'transaction').mockImplementationOnce(async (options, fn) => {
      queued.row.status = 'running'; queued.row.startedAt = 2_700;
      return transaction(options, fn);
    });
    await expect(queued.release()).resolves.toEqual({ released: 0 });
    expect(queued.row.schedulerHandoffReleased).toBe(false); expect(queued.scheduler).not.toHaveBeenCalled();
  });

  it('denies a released retry that claims before runtime recovery reserves the pod', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    await expect(queued.release()).resolves.toEqual({ released: 1 });
    queued.row.status = 'running'; queued.row.startedAt = 2_700;
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('does not admit an attempted inbound migration as a released source dependency', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    queued.row.input.fromGatewayId = 'shared-foreign'; queued.row.input.toGatewayId = 'shared-1';
    Object.assign(queued.row, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3_000 });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('continues releasing a failed held migration through the native scheduler', async () => {
    const h = harness(); const queued = blockedPreTransportMigration(h);
    queued.row.status = 'failed';
    queued.row.steps = [{ name: 'quiesce-source', status: 'done' }, { name: 'final-sync-state', status: 'failed' }];
    const scheduler = vi.fn(async () => ({ agentIds: [] }));
    await expect(releaseAbandonedSchedulerHandoffs({ store: h.deps.store, scheduler,
      gatewayExists: async () => true, log: vi.fn(), now: () => 3_000 })).resolves.toEqual({ released: 1 });
    expect(scheduler.mock.calls).toEqual([
      ['shared-2', { migrationId: 'mig-queued:scheduler:13:claim:2300', slug: 'bob', phase: 'abort' }],
      ['shared-1', { migrationId: 'mig-queued:scheduler:13:claim:2300', slug: 'bob', phase: 'resume' }],
    ]);
    expect(queued.row).toMatchObject({ status: 'failed', schedulerHandoffReleased: true });
  });

  it.each(['implicit', 'zero'])('recovers ahead of unclaimed queued migrations with %s attempts while the real claim path retains the restart fence', async count => {
    const { h, next, deps, intent } = await failedRecovery();
    const queued = queuedMigration(h);
    if (count === 'zero') Object.assign(h.store['glmOperations/queued'], { attempts: 0, resumeCount: 0, attemptHistory: [] });
    const queuedBefore = structuredClone(h.store['glmOperations/queued']);
    await queued.run();
    expect(queued.handler).not.toHaveBeenCalled();
    expect(queued.log).toHaveBeenCalledWith(expect.stringContaining('runtime restart outcome is unresolved'));
    expect(h.store['glmOperations/queued']).toEqual(queuedBefore);
    const kubectl = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async args => {
      if (args.includes('patch')) {
        expect(h.store['gateways/shared-1'].runtimeRestartFence.attemptId).toBe(next.id);
        await queued.run();
        expect(queued.handler).not.toHaveBeenCalled();
        expect(h.store['glmOperations/queued']).toEqual(queuedBefore);
      }
      return kubectl(args);
    });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.store['glmOperations/queued']).toEqual(queuedBefore);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toMatchObject({ phase: 'dispatched', attemptId: intent.attemptId });
    const claimStartedAt = h.store['glmOperations/return'].restoreAttempt.claimStartedAt + 1;
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: claimStartedAt, attemptHistory: [] });
    const stateDeps: FleetStateDeps = { store: createDocumentFixtureStore(h.store) };
    const owned = await beginUserRestore(stateDeps, { uid: intent.uid, slug: intent.slug, gatewayId: intent.gatewayId,
      fromGatewayId: intent.fromGatewayId, assignmentEpoch: intent.assignmentEpoch, operationId: intent.operationId,
      claimStartedAt, attemptId: 'native-resume' }, { resume: true });
    await acknowledgeUserRestore(stateDeps, owned);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeUndefined();
    await queued.run();
    expect(queued.handler).toHaveBeenCalledOnce();
    expect(h.store['glmOperations/queued']).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('refuses recovery if the migration claim wins before restart custody is reserved', async () => {
    const h = harness();
    const queued = queuedMigration(h);
    let entered!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    queued.handler.mockImplementation(async () => { entered(); await held; return { success: true, steps: [] }; });
    const claim = queued.run();
    await claimed;
    try {
      expect(h.store['glmOperations/queued']).toMatchObject({ status: 'running', firstStartedAt: expect.any(Number) });
      await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
      expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
      expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    } finally { release(); await claim; }
  });

  it.each([
    ['startedAt', 1], ['startedAt', undefined], ['firstStartedAt', 1], ['firstStartedAt', null],
    ['lastProgressAt', 1], ['lastResumedAt', 1], ['attempts', 1], ['attempts', '0'], ['resumeCount', 1],
    ['attemptHistory', [{}]], ['attemptHistory', {}], ['steps', [{}]], ['steps', undefined],
    ['userMigrationV2', { phase: 'initialized' }], ['schedulerHandoff', {}], ['sourceTransferExecution', {}],
    ['restoreAttempt', {}], ['cutoverCommittedAt', 1], ['output', {}], ['nextAttemptAt', 1],
    ['completedAt', 1], ['completedAt', undefined], ['status', 'running'], ['createdAt', 0], ['createdAt', undefined],
    ['input', { fromGatewayId: 'shared-1' }], ['schedulerHandoffReleased', false], ['schedulerHandoffLost', 'unknown'],
    ['cancellationRequestedAt', 1], ['error', 'prior error'], ['rolledBack', false],
  ])('still blocks queued migration with prior or unknown work in %s=%j', async (field, value) => {
    const h = harness(); queuedMigration(h);
    h.store['glmOperations/queued'][field as string] = value;
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('another migration is active');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });

  it('transfers a failed recovery fence to one new build without reopening the predecessor or acknowledging native restore', async () => {
    const { h, next, deps, predecessor, intent, nextImages } = await failedRecovery();
    const priorOperation = structuredClone(h.store['glmOperations/recover']);
    let observedTransfer = false;
    h.ctx.assertActiveClaim.mockImplementation(async () => {
      const fence = h.store['gateways/shared-1'].runtimeRestartFence;
      if (fence?.attemptId === next.id) {
        observedTransfer = true;
        expect(fence.target.podUid).toBe(predecessor.fence.target.podUid);
        expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(intent);
      }
    });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(observedTransfer).toBe(true);
    expect(h.store['glmOperations/recover']).toEqual(priorOperation);
    expect(h.store['glmOperations/successor'].restoreRuntimeRecovery).toMatchObject({ images: nextImages, previousRestoreAttempt: intent });
    expect(h.store['glmOperations/successor'].input.restoreRecovery.supersede).toEqual(predecessor);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toMatchObject({ attemptId: intent.attemptId, phase: 'dispatched', reauthorizedBy: 'successor' });
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    const renewed = h.store['glmOperations/return'].restoreAttempt;
    const claimStartedAt = renewed.claimStartedAt + 1;
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: claimStartedAt, attemptHistory: [] });
    const stateDeps: FleetStateDeps = { store: createDocumentFixtureStore(h.store) };
    const owned = await beginUserRestore(stateDeps, { uid: intent.uid, slug: intent.slug, gatewayId: intent.gatewayId,
      fromGatewayId: intent.fromGatewayId, assignmentEpoch: intent.assignmentEpoch, operationId: intent.operationId,
      claimStartedAt, attemptId: 'native-resume' }, { resume: true });
    await acknowledgeUserRestore(stateDeps, owned);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeUndefined();
    expect(h.store['glmOperations/return'].restoreAttempt.phase).toBe('acknowledged');
  });
  it.each(['missing-fence', 'stale-id', 'running', 'succeeded', 'completed-proof', 'input-drift', 'unknown-predecessor',
    'pod-uid', 'pod-name', 'return', 'epoch', 'custody', 'reauthorization-drift', 'rebound-epoch', 'images', 'fence-drift', 'cancelled'])('rejects predecessor %s before changing custody or pod images', async (change) => {
    const { h, next, deps } = await failedRecovery();
    if (change === 'missing-fence') delete h.store['gateways/shared-1'].runtimeRestartFence;
    if (change === 'stale-id') (next.input.restoreRecovery as any).supersede.operationId = 'stale';
    if (change === 'running') h.store['glmOperations/recover'].status = 'running';
    if (change === 'succeeded') h.store['glmOperations/recover'].status = 'succeeded';
    if (change === 'completed-proof') h.store['glmOperations/recover'].restoreRuntimeRecovery = { completedAt: 500 };
    if (change === 'input-drift') h.store['glmOperations/recover'].input.extra = true;
    if (change === 'unknown-predecessor') delete h.store['glmOperations/recover'];
    if (change === 'pod-uid') h.pod.metadata.uid = 'replacement';
    if (change === 'pod-name') h.pod.metadata.name = 'replacement';
    if (change === 'return') (next.input.restoreRecovery as any).operationId = 'other-return';
    if (change === 'epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
    if (change === 'custody') {
      h.store['glmOperations/return'].restoreAttempt.claimStartedAt++;
      h.store['users/u'].provisioning.openclaw.restoreFence.claimStartedAt++;
    }
    if (change === 'reauthorization-drift' || change === 'rebound-epoch') {
      const field = change === 'reauthorization-drift' ? 'claimStartedAt' : 'assignmentEpoch';
      h.store['glmOperations/return'].restoreAttempt[field]++;
      h.store['users/u'].provisioning.openclaw.restoreFence[field]++;
      (next.input.restoreRecovery as any).reauthorize[field]++;
      if (change === 'rebound-epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
    }
    if (change === 'images') h.pod.spec.containers[0].image = 'unclaimed-image';
    if (change === 'fence-drift') h.store['gateways/shared-1'].runtimeRestartFence.startedAt++;
    if (change === 'cancelled') h.store['glmOperations/recover'].cancellationRequestedAt = 1;
    h.store['glmOperations/successor'].input = structuredClone(next.input);
    const before = structuredClone(h.store);
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('rejects a second successor after the first has atomically acquired the retained fence', async () => {
    const { h, next, deps } = await failedRecovery();
    h.lostReply();
    await expect(recoverSharedRestoreRuntime(deps, next, h.ctx)).rejects.toThrow('unresolved');
    const owned = structuredClone(h.store['gateways/shared-1'].runtimeRestartFence);
    expect(owned.attemptId).toBe('successor');
    const other = { ...next, id: 'competitor', startedAt: 700 };
    h.store['glmOperations/competitor'] = structuredClone(other);
    await expect(recoverSharedRestoreRuntime(deps, other, h.ctx)).rejects.toThrow('predecessor changed');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toEqual(owned);
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it('waits for accepted successor images without repeating their patch and keeps native custody unchanged until ready', async () => {
    const { h, next, deps, intent } = await failedRecovery();
    h.setReady(false);
    let clock = 1;
    await expect(recoverSharedRestoreRuntime({ ...deps, now: () => clock, wait: async () => { clock += 240_000; } }, next, h.ctx))
      .rejects.toThrow('images are not ready');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.attemptId).toBe(next.id);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(intent);
    await expect(recoverSharedRestoreRuntime({ ...deps, now: () => clock, wait: async () => { clock += 240_000; } }, next, h.ctx))
      .rejects.toThrow('images are not ready');
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
    h.pod.status.containerStatuses.forEach((container: any) => { container.ready = true; });
    await recoverSharedRestoreRuntime(deps, next, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence.reauthorizedBy).toBe(next.id);
  });
  it('reauthorizes only the retained paired intent after same-pod image readiness, preserving the original journal evidence', async () => {
    const h = harness(); const before = reauthorize(h);
    const scope = { uid: before.uid, slug: before.slug, gatewayId: before.gatewayId, fromGatewayId: before.fromGatewayId,
      assignmentEpoch: before.assignmentEpoch, operationId: before.operationId, attemptId: 'new-request', claimStartedAt: 300 };
    const stateDeps: FleetStateDeps = { store: createDocumentFixtureStore(h.store) };
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: 300, attemptHistory: [] });
    await expect(beginUserRestore(stateDeps, scope, { resume: true })).rejects.toThrow('resumption');
    h.store['glmOperations/return'].status = 'pending';
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    const renewed = h.store['glmOperations/return'].restoreAttempt;
    expect(renewed).toMatchObject({ uid: before.uid, attemptId: before.attemptId, assignmentEpoch: before.assignmentEpoch,
      operationId: before.operationId, phase: 'dispatched', reauthorizedBy: 'recover' });
    expect(renewed.claimStartedAt).toBeGreaterThan(200);
    expect(renewed.dispatchClaimStartedAt).toBe(renewed.claimStartedAt);
    expect(renewed.dispatchedAt).toBe(renewed.claimStartedAt);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(renewed);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery.previousRestoreAttempt).toEqual(before);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    const calls = h.deps.runKubectl.mock.calls.length;
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl).toHaveBeenCalledTimes(calls);
    expect(h.store['glmOperations/return'].restoreAttempt).toEqual(renewed);
    const nextClaim = renewed.claimStartedAt + 1;
    Object.assign(h.store['glmOperations/return'], { status: 'running', startedAt: nextClaim, attemptHistory: [] });
    const owned = await beginUserRestore(stateDeps, { ...scope, claimStartedAt: nextClaim }, { resume: true });
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeDefined();
    await acknowledgeUserRestore(stateDeps, owned);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toBeUndefined();
    expect(h.store['glmOperations/return'].restoreAttempt.phase).toBe('acknowledged');
  });
  it('does not reauthorize after an ambiguous patch reply until readiness is observed on retry', async () => {
    const h = harness(); const before = reauthorize(h); h.lostReply();
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('unresolved');
    expect(h.store['glmOperations/return'].restoreAttempt).toEqual(before);
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/return'].restoreAttempt.reauthorizedBy).toBe('recover');
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });
  it('rejects a changed paired intent even when both live copies agree', async () => {
    const h = harness(); reauthorize(h);
    h.store['glmOperations/return'].restoreAttempt.claimStartedAt++;
    h.store['users/u'].provisioning.openclaw.restoreFence.claimStartedAt++;
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('reauthorization');
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('refuses to renew terminally failed returns rather than reporting recovery without a runnable native return', async () => {
    const h = harness(); const before = reauthorize(h);
    h.store['glmOperations/return'].status = 'failed';
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('reauthorization');
    expect(h.store['glmOperations/return'].restoreAttempt).toEqual(before);
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(before);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery).toBeUndefined();
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('keeps both fences when the return is claimed during the image update', async () => {
    const h = harness(); const before = reauthorize(h);
    h.ctx.assertActiveClaim.mockImplementation(async () => {
      if (h.ctx.assertActiveClaim.mock.calls.length === 4) h.store['glmOperations/return'].status = 'running';
    });
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('authority');
    expect(h.store['users/u'].provisioning.openclaw.restoreFence).toEqual(before);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined();
    h.store['glmOperations/return'].status = 'pending';
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it('changes only same-pod images and preserves user intent and release policy', async () => {
    const h = harness(); const before = structuredClone(h.store['users/u']); const root = structuredClone(h.store['gateways/shared-1']);
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.store['users/u']).toEqual(before);
    expect(h.store['gateways/shared-1']).toEqual(root);
    expect(h.store['glmOperations/recover'].restoreRuntimeRecovery).toMatchObject({ podUid: 'pod-uid', sourceSha: sha, images });
  });
  it('observes an executed patch after a lost reply without redispatch or a new pod', async () => {
    const h = harness(); h.lostReply();
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('unresolved');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.phase).toBe('dispatched');
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl.mock.calls.filter(([args]) => args.includes('patch'))).toHaveLength(1);
  });
  it('retains durable completion if the worker dies before reporting success', async () => {
    const h = harness(); await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    h.store['glmOperations/return'].status = 'succeeded';
    const calls = h.deps.runKubectl.mock.calls.length;
    await recoverSharedRestoreRuntime(h.deps, h.op, h.ctx);
    expect(h.deps.runKubectl).toHaveBeenCalledTimes(calls);
  });
  it.each(['running-return', 'foreign-intent', 'epoch', 'retired', 'builder', 'roll', 'foreign-restart', 'migration', 'retained-transfer', 'stale-claim', 'cancelled', 'disk', 'wrong-owner', 'wrong-build'])('rejects %s before any image patch', async change => {
    const h = harness();
    if (change === 'running-return') h.store['glmOperations/return'].status = 'running';
    if (change === 'foreign-intent') h.store['users/u'].provisioning.openclaw.restoreFence.attemptId = 'foreign';
    if (change === 'epoch') h.store['gateways/shared-1/assignments/u'].epoch++;
    if (change === 'retired') h.store['gateways/shared-1'].desiredStatus = 'retired';
    if (change === 'builder') h.store['gateways/shared-1'].gatewayClass = 'builder';
    if (change === 'roll') h.store['gateways/shared-1'].desiredRelease++;
    if (change === 'foreign-restart') h.store['gateways/shared-1'].runtimeRestartFence = {};
    if (change === 'migration') h.store['glmOperations/other'] = { kind: 'migrate-user', status: 'pending', input: { fromGatewayId: 'shared-1' } };
    if (change === 'retained-transfer') h.store['users/other'] = { provisioning: { openclaw: { sourceTransferFence: { sourceGatewayId: 'shared-1' } } } };
    if (change === 'stale-claim') h.store['glmOperations/recover'].startedAt++;
    if (change === 'cancelled') h.store['glmOperations/recover'].cancellationRequestedAt = 1;
    if (change === 'disk') h.pod.spec.volumes = [];
    if (change === 'wrong-owner') h.pod.metadata.ownerReferences[0].uid = 'foreign';
    if (change === 'wrong-build') h.deps.sourceSha = 'd'.repeat(40);
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('refuses replacement pod storage after an ambiguous dispatch', async () => {
    const h = harness(); h.lostReply(); await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    h.pod.metadata.uid = 'replacement';
    await expect(recoverSharedRestoreRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('restart outcome');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined();
  });
});

describe('journaled Shared source schema repair', () => {
  function readAuthority(rows: Record<string, any>, operationId: string) {
    return createDocumentFixtureStore(rows).transaction({ label: 'test.source-authority', readOnly: true },
      transaction => readSharedSourceRecoveryAuthority(transaction, 'shared-1', operationId));
  }
  async function sourceHarness(management = false, absent = false) {
    const h = harness();
    for (const key of Object.keys(h.store)) if (key.startsWith('users/') || key.includes('/assignments/') || key === 'glmOperations/return') delete h.store[key];
    Object.assign(h.store['gateways/shared-1'], { gatewayId: 'shared-1', ownerUid: null, builderSlug: null, latestRelease: 1, desiredStatus: 'draining' });
    for (const [index, slug] of ['jdog99', 'oct01', 'journeyd093e6f87', 'journey94a458e32', 'jefe', 'oct08'].entries()) {
      const uid = `source-${index}`, id = `octogee-${slug}-coach`, file = `/home/node/.openclaw/agents/${id}/agent/openclaw-agent.sqlite`;
      const error = '/push-rsync-state/shared-1: 500 ' + JSON.stringify({ error: 'push-rsync-state failed', message:
        `OpenClaw snapshot of ${id} failed: SQLite database cannot be snapshotted safely: ${file}. OpenClaw agent database ${file} uses schema version 24; run openclaw doctor --fix before compacting it.` });
      h.store[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: 'shared-1', status: 'complete' } } };
      h.store[`gateways/shared-1/assignments/${uid}`] = { uid, slug, gatewayId: 'shared-1', source: 'onboarding', state: 'serving', epoch: index + 1,
        createdAt: 1, updatedAt: 1, updatedByOperationId: null };
      h.store[`users/${uid}/agentStores/${id}`] = { agentId: id, gatewayId: 'shared-1', assignmentEpoch: index + 1, storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, schema: `source_${index}`, recordedAt: 1 };
      h.store[`glmOperations/export-${index}`] = { kind: 'migrate-user', status: 'failed', startedAt: 100, completedAt: 200,
        input: { uid, fromGatewayId: 'shared-1', toGatewayId: 'shared-2' }, error,
        steps: [{ name: 'pre-sync-state', status: 'failed', error }, { name: 'rollback:unmount-target', status: 'done' }] };
    }
    if (management) {
      h.store['glmGateways/shared-1'] = { runtime: 'cluster', kubernetes: { totalPods: 1, readyPods: 1, status: 'ready', pods: [{ uid: 'pod-uid', name: 'pod' }] },
        heartbeat: { status: 'ready', lastHeartbeatAt: Date.now(), mountedCustomers: ['jdog99', 'oct01'], migratingIn: [] } };
      h.pod.metadata.namespace = 'octogee-test'; h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
      h.pod.status.containerStatuses = h.pod.spec.containers.map((c: any) => ({ name: c.name, ready: true, imageID: c.image }));
      for (let index = 2; index < 6; index++) {
        delete h.store[`users/source-${index}`]; delete h.store[`gateways/shared-1/assignments/source-${index}`]; delete h.store[`glmOperations/export-${index}`];
      }
      for (let index = 0; index < 2; index++) {
        const uid = `source-${index}`, slug = ['jdog99', 'oct01'][index], row = h.store[`glmOperations/export-${index}`];
        const operationId = continuousPlacementMigrationOperationId({ uid, builderSlug: slug!, fromGatewayId: 'shared-1', toGatewayId: 'shared-2', sourceAssignmentEpoch: index + 1 });
        delete h.store[`glmOperations/export-${index}`]; h.store[`glmOperations/${operationId}`] = row;
        Object.assign(row, { origin: 'automatic', createdBy: 'glm-controller-placement-policy', attempts: 1,
          error: '/quiesce/shared-1: 500 ' + JSON.stringify({ error: 'quiesce failed', message: 'WorkerTaskError: Session history database read was revoked: code=unavailable' }),
          rolledBack: true, schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 250, attemptHistory: [],
          schedulerHandoff: { migrationId: `mig-${operationId}:scheduler:1:claim:${row.startedAt}`, fromGatewayId: 'shared-1', toGatewayId: 'shared-2', uid, slug } });
        Object.assign(row.input, { userSlug: slug, source: 'continuous-placement-policy' });
        row.steps = [{ name: 'keys-sync-state', status: 'done' }, { name: 'pre-sync-state', status: 'done' },
          { name: 'wait-for-active-work', status: 'failed', error: row.error }, { name: 'rollback:unmount-target', status: 'done' }];
        row.attemptHistory = [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }];
        Object.assign(h.store[`users/${uid}`].provisioning.openclaw, { mounted: true });
      }
    }
    if (absent) delete h.store['users/source-0'].provisioning.openclaw.migration;
    const podDeps = h.deps, store = createDocumentFixtureStore(h.store);
    const captured = await readAuthority(h.store, h.op.id);
    h.op.input = { gatewayId: 'shared-1', sourceRecovery: { sourceSha: sha, images, ...captured } };
    h.store['glmOperations/recover'].input = structuredClone(h.op.input);
    let ack = true, wrongImage = false, healthyWithoutAck = false, managementFailure = false, changedAfterProbe = false, transportFailure = false;
    let managementReceipt: string | undefined;
    const runKubectl = vi.fn(async (args: string[]) => {
      if (args.includes('exec')) {
        if (transportFailure) throw new Error('worker transport rejected');
        if (changedAfterProbe) h.store['users/source-0'].provisioning.openclaw.migration.startedAt++;
        return { code: managementFailure ? 1 : 0, stdout: managementFailure ? '' : managementReceipt ?? JSON.stringify({ version: 1, attemptId: h.op.id, bootId: 'fresh-boot', health: true }), stderr: '' };
      }
      if (args.includes('patch')) {
        const saved = h.store['gateways/shared-1'].runtimeRestartFence;
        expect(saved.kind).toBe('source-recovery'); expect(saved.phase).toBe('dispatched');
        expect(saved.doctor.startedAt).toBeUndefined(); expect(saved.installedImage).toBeUndefined();
        const patch = JSON.parse(args[args.indexOf('-p') + 1]);
        expect(patch.slice(0, 2)).toEqual([{ op: 'test', path: '/metadata/uid', value: 'pod-uid' }, { op: 'test', path: '/metadata/resourceVersion', value: 'rv' }]);
        for (const item of patch.filter((item: any) => item.op === 'replace')) h.pod.spec.containers[Number(item.path.split('/')[3])].image = item.value;
        h.pod.status.conditions = [{ type: 'Ready', status: healthyWithoutAck ? 'True' : 'False' }];
        h.pod.status.containerStatuses = h.pod.spec.containers.map((c: any) => ({ name: c.name, ready: healthyWithoutAck,
          imageID: wrongImage ? 'old-image' : c.image, state: { running: { startedAt: 'now' } } }));
      }
      const fence = h.store['gateways/shared-1'].runtimeRestartFence;
      if (args.includes('pod') && ack && fence?.installedImage && !fence.doctor.completedAt) {
        expect(fence.installedImage.podUid).toBe('pod-uid');
        if (!healthyWithoutAck) expect(h.pod.status.conditions[0].status).toBe('False');
        const now = Date.now();
        fence.doctor = { ...fence.doctor, releaseKey: 'actual-reused-image-tag', startedAt: now, completedAt: now,
          verifiedAgentIds: fence.target.agents.map((a: any) => a.agentId) };
        h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
        for (const c of h.pod.status.containerStatuses) c.ready = true;
      }
      const result = args.includes('pods') ? { items: [h.pod] } : args.includes('replicaset') ?
        { metadata: { uid: 'rs-uid', ownerReferences: [{ controller: true, kind: 'Deployment', uid: 'deployment-uid' }] } } :
        args.includes('deployment') ? { metadata: { uid: 'deployment-uid' } } : h.pod;
      return { code: 0, stdout: JSON.stringify(result), stderr: '' };
    });
    let clock = Date.now();
    return { ...h, deps: { ...podDeps, store, runKubectl, now: () => clock, wait: async () => { clock += 600_000; } },
      setManagementTransportFailure: () => { transportFailure = true; }, setManagementReceipt: (value: string) => { managementReceipt = value; },
      setManagementFailure: (value = true) => { managementFailure = value; }, setChangedAfterProbe: () => { changedAfterProbe = true; },
      setAck: (value: boolean) => { ack = value; }, setWrongImage: () => { wrongImage = true; }, setHealthyWithoutAck: () => { healthyWithoutAck = true; } };
  }
  async function postgresSourceHarness() {
    const h = await sourceHarness(true);
    const root = () => h.store['gateways/shared-1'];
    Object.assign(root(), { configSchemaVersion: 1, createdAt: 1, createdBy: 'operator', updatedAt: 1, updatedBy: 'operator',
      profile: 'standard', imageProfile: 'standard', sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null,
      serviceAccountName: null, serviceAccount: null, builderAccess: null, modelBrokerLimits: null });
    const payload = { imageRepository: images.gateway.split(':aaaaaaa')[0]!, imageTag: images.gateway.split('octogee-gateway:')[1]!,
      gatewayEdgeImage: { imageRepository: images['gateway-edge'].split(':aaaaaaa')[0]!, imageTag: images['gateway-edge'].split('gateway-edge:')[1]! } };
    for (const [index, slug] of ['jdog99', 'oct01'].entries()) {
      const uid = `source-${index}`;
      delete h.store[`users/${uid}`].provisioning.openclaw.migration;
      const row = Object.values(h.store).find((value: any) => value.input?.uid === uid && value.kind === 'migrate-user')!;
      row.error = '/finish-rsync-import/shared-2: 500 ' + JSON.stringify({ error: 'import failed', message:
        `[import:${slug}] agents.create failed for octogee-${slug}-coach (AgentDatabaseMaintenanceRequiredError: Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)` });
      row.steps = ['keys-sync-state', 'pre-sync-state', 'wait-for-active-work', 'quiesce-source', 'flush-source',
        'rollback:unmount-target', 'rollback:resume-ingress'].map(name => ({ name, status: 'done' }));
      row.steps.push({ name: 'final-sync-state', status: 'failed', error: row.error });
      row.attemptHistory = [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }];
      h.store[`workspaces/${slug}/projects/orbit`] = { ownerUid: uid, agent: { status: 'ready' } };
      for (const [agentIndex, agentId] of [`octogee-${slug}-coach`, `octogee-${slug}-proj-orbit-coach`].entries()) {
        h.store[`users/${uid}/agentStores/${agentId}`] = { agentId, gatewayId: 'shared-1', assignmentEpoch: index + 1,
          storeId: `00000000-0000-4000-8000-${String(index * 2 + agentIndex + 1).padStart(12, '0')}`, schema: `retained_source_${index}_${agentIndex}`, recordedAt: 1 };
      }
    }
    const captured = await readAuthority(h.store, h.op.id);
    expect(captured.postgresAgentStores).toHaveLength(4);
    h.op.input.sourceRecovery = { sourceSha: sha, images, payload, ...captured };
    h.store['glmOperations/recover'].input = structuredClone(h.op.input);
    const resource = (name: string, uid: string) => ({ metadata: { name, uid, namespace: 'octogee-test', resourceVersion: '1' },
      spec: { replicas: 1, paused: false, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        template: { spec: { containers: structuredClone(h.pod.spec.containers) } } } });
    const deployment = resource('octogee-gateway-shared-1', 'deployment-uid'), replicaSet = resource('rs', 'rs-uid');
    (replicaSet.metadata as any).ownerReferences = [{ controller: true, kind: 'Deployment', uid: 'deployment-uid' }];
    const events: string[] = [];
    let acknowledgment: 'full' | 'partial' | 'error' | 'none' = 'full';
    let afterEffect: ((event: string) => void) | undefined;
    const runKubectl = vi.fn(async (args: string[], options?: { stdin?: string; timeoutMs?: number }) => {
      if (options?.stdin?.includes('sourceRecoveryDiscoveryPreflight')) return {
        code: 0, stdout: JSON.stringify({ version: 1, podUid: h.pod.metadata.uid, agentIds: captured.postgresAgentStores!.map(store => store.agentId).sort() }), stderr: '',
      };
      if (args.includes('exec')) {
        events.push('management-health');
        expect(root().runtimeRestartFence.doctor.verifiedAgentIds).toEqual(captured.postgresAgentStores!.map(store => store.agentId));
        expect(root().desiredRelease).toBe(1); expect(root().runtimeRestartFence).toBeDefined();
        afterEffect?.('management-health');
        return { code: 0, stdout: JSON.stringify({ version: 1, attemptId: h.op.id, bootId: 'retained-new-image-boot', health: true }), stderr: '' };
      }
      const kind = args.includes('deployment') ? 'deployment' : args.includes('replicaset') ? 'replicaset' : 'pod';
      const value: any = kind === 'deployment' ? deployment : kind === 'replicaset' ? replicaSet : h.pod;
      if (args.includes('patch')) {
        const patch = JSON.parse(args[args.indexOf('-p') + 1]);
        const changed = patch.filter((item: any) => item.op !== 'test');
        const event = changed.some((item: any) => item.path === '/spec/paused') ? (changed[0].value ? 'pause-deployment' : 'resume-deployment') : `pin-${kind}`;
        if (event === 'resume-deployment') {
          expect(root()).toMatchObject({ latestRelease: 2, desiredRelease: 2, liveRelease: 1 });
          expect(root().runtimeRestartFence).toBeUndefined();
          expect(h.store['gateways/shared-1/releases/2'].payload).toEqual(payload);
          expect(h.store[`glmOperations/${h.op.id}`].sourceRuntimeRecovery.managementHealth.health).toBe(true);
        } else expect(root().runtimeRestartFence.phase).toBe('dispatched');
        if (kind === 'pod') {
          expect(deployment.spec.paused).toBe(true);
          for (const workload of [deployment, replicaSet]) expect(Object.fromEntries(workload.spec.template.spec.containers.map((c: any) => [c.name, c.image]))).toEqual(images);
        }
        for (const item of patch) {
          const parts = item.path.slice(1).split('/'); let target = value;
          for (const part of parts.slice(0, -1)) target = target[part];
          const key = parts.at(-1)!;
          if (item.op === 'test') expect(target[key]).toEqual(item.value);
          else target[key] = item.value;
        }
        value.metadata.resourceVersion += '-next';
        if (kind === 'pod') {
          h.pod.status.conditions = [{ type: 'Ready', status: 'False' }];
          h.pod.status.containerStatuses = h.pod.spec.containers.map((c: any) => ({ name: c.name, ready: false, imageID: c.image, state: { running: { startedAt: 'new-image' } } }));
        }
        events.push(event); afterEffect?.(event);
      }
      const fence = root().runtimeRestartFence;
      if (kind === 'pod' && !args.includes('patch') && fence?.attemptId === h.op.id && fence.installedImage && !fence.doctor.completedAt && acknowledgment !== 'none') {
        const at = h.deps.now();
        fence.doctor = { ...fence.doctor, releaseKey: 'actual-reused-image-tag', startedAt: at, completedAt: at,
          verifiedAgentIds: captured.postgresAgentStores!.map(store => store.agentId).slice(0, acknowledgment === 'partial' ? 1 : undefined),
          ...(acknowledgment === 'error' ? { error: 'doctor refused retained store' } : {}) };
        h.pod.status.conditions = [{ type: 'Ready', status: 'True' }];
        for (const status of h.pod.status.containerStatuses) status.ready = true;
        events.push('doctor-ack'); afterEffect?.('doctor-ack');
      }
      return { code: 0, stdout: JSON.stringify(args.includes('pods') ? { items: [h.pod] } : value), stderr: '' };
    });
    return { ...h, deps: { ...h.deps, runKubectl }, deployment, replicaSet, events, captured, payload,
      setAcknowledgment: (value: typeof acknowledgment) => { acknowledgment = value; }, onEffect: (effect: (event: string) => void) => { afterEffect = effect; } };
  }
  async function schedulerSourceHarness() {
    const h = await postgresSourceHarness();
    for (const row of Object.values(h.store)) {
      if (row.kind !== 'migrate-user' || row.status !== 'failed') continue;
      row.error = '/scheduler/shared-2: 500 ' + JSON.stringify({ error: 'scheduler migration failed',
        message: 'Invalid cron migration snapshot: job 00000000-0000-4000-8000-000000000099 is not persistable (invalid-payload)' });
      row.steps.find((step: any) => step.name === 'final-sync-state').error = row.error;
      row.attemptHistory = [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }];
    }
    const captured = await readAuthority(h.store, h.op.id);
    expect(captured.schedulerStateRecovery).toBe(true);
    h.op.input.sourceRecovery = { sourceSha: sha, images, payload: h.payload, ...captured };
    h.store['glmOperations/recover'].input = structuredClone(h.op.input);
    return h;
  }
  it('waits for cold scheduler repair and startup beyond ten minutes before releasing the source', async () => {
    const h = await schedulerSourceHarness(), start = Date.now();
    let clock = start;
    h.setAcknowledgment('none'); h.deps.now = () => clock;
    h.deps.wait = async () => { clock += 60_000; if (clock - start >= 720_000) h.setAcknowledgment('full'); };
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(clock - start).toBe(720_000);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.managementHealth.health).toBe(true);
  });
  it('keeps stalled scheduler repair fenced at the twenty-minute deadline', async () => {
    const h = await schedulerSourceHarness(), start = Date.now();
    let clock = start;
    h.setAcknowledgment('none'); h.deps.now = () => clock;
    h.deps.wait = async () => { clock += 60_000; };
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    expect(clock - start).toBe(1_200_000);
    expect(h.store['gateways/shared-1'].runtimeRestartFence.installedImage.podUid).toBe('pod-uid');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.doctor.completedAt).toBeUndefined();
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined();
  });
  it('refuses foreign discovery before reserving or changing the retained PostgreSQL source', async () => {
    const h = await postgresSourceHarness(), before = structuredClone(h.store);
    const run = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async (args, options) => {
      if (options?.stdin?.includes('sourceRecoveryDiscoveryPreflight')) return { code: 1, stdout: '', stderr: 'source discovery requires stale local store resolution: octogee-foreign-coach' };
      return run(args, options);
    });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source discovery requires stale local store resolution');
    expect(h.store).toEqual(before); expect(h.events).toEqual([]);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('can retry the same source operation after a pre-reservation discovery refusal without a spent Doctor fence', async () => {
    const h = await postgresSourceHarness(), run = h.deps.runKubectl.getMockImplementation()!;
    let blocked = true;
    h.deps.runKubectl.mockImplementation(async (args, options) => {
      if (blocked && options?.stdin?.includes('sourceRecoveryDiscoveryPreflight')) return { code: 1, stdout: '', stderr: 'foreign directory' };
      return run(args, options);
    });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('stale local store resolution');
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
    blocked = false;
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.events.filter(event => event === 'doctor-ack')).toHaveLength(1);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it.each(['claim', 'pod', 'authority'])('refuses %s loss during local discovery before any reservation or image change', async race => {
    const h = await postgresSourceHarness(), run = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async (args, options) => {
      const result = await run(args, options);
      if (options?.stdin?.includes('sourceRecoveryDiscoveryPreflight')) {
        if (race === 'claim') h.store['glmOperations/recover'].cancellationRequestedAt = 10;
        if (race === 'pod') h.pod.metadata.uid = 'recreated-pod';
        if (race === 'authority') h.store['gateways/shared-1'].retirementClaim = { operationId: 'retire' };
      }
      return result;
    });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined(); expect(h.events).toEqual([]);
    expect(h.deps.runKubectl.mock.calls.some(([args]) => args.includes('patch'))).toBe(false);
  });
  it('repairs retained PostgreSQL source images through the handler and journals a desired release only after full Doctor and health proof', async () => {
    const h = await postgresSourceHarness(), before = structuredClone(h.store), volumes = structuredClone(h.pod.spec.volumes);
    const handler = createRestartGatewayHandler({ kubeOps: {} as never, namespace: h.deps.namespace, resolveLiveRevisionId: async () => null,
      now: h.deps.now, log: vi.fn(), recoverSource: (op, ctx) => recoverSharedSourceRuntime(h.deps, op, ctx) });
    expect(await handler(h.op, h.ctx)).toMatchObject({ success: true });
    expect(h.events).toEqual(['pause-deployment', 'pin-replicaset', 'pin-deployment', 'pin-pod', 'doctor-ack', 'management-health', 'resume-deployment']);
    expect(h.pod.metadata.uid).toBe('pod-uid'); expect(h.pod.spec.volumes).toEqual(volumes);
    for (const [path, row] of Object.entries(before)) if (path.startsWith('users/') || path.startsWith('workspaces/') || path.includes('/assignments/')) expect(h.store[path]).toEqual(row);
    const rollout = Object.values(h.store).find((row: any) => row.kind === 'rollout')!;
    expect(rollout).toMatchObject({ status: 'pending', input: { gatewayId: 'shared-1', targetRelease: 2 } });
    expect(h.store['gateways/shared-1/releases/2']).toMatchObject({ release: 2, sourceRelease: 1, createdBy: h.op.id });
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.doctor.verifiedAgentIds).toEqual(h.captured.postgresAgentStores!.map(store => store.agentId));
  });
  it.each(['partial', 'error', 'none'] as const)('keeps PostgreSQL source fenced and Deployment paused after %s Doctor proof', async proof => {
    const h = await postgresSourceHarness(); h.setAcknowledgment(proof);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined(); expect(h.deployment.spec.paused).toBe(true);
    expect(h.store['gateways/shared-1/releases/2']).toBeUndefined(); expect(h.events).not.toContain('management-health'); expect(h.events).not.toContain('resume-deployment');
  });
  it.each(['pin-replicaset', 'doctor-ack', 'management-health'])('refuses changed operation claim after %s without clearing the PostgreSQL fence', async stage => {
    const h = await postgresSourceHarness();
    h.onEffect(event => { if (event === stage) h.store['glmOperations/recover'].startedAt++; });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined(); expect(h.deployment.spec.paused).toBe(true);
    expect(h.store['gateways/shared-1/releases/2']).toBeUndefined(); expect(h.events).not.toContain('resume-deployment');
    if (stage === 'pin-replicaset') expect(h.events).not.toContain('pin-pod');
  });
  it('retains the PostgreSQL fence when desired root authority changes after fresh management health', async () => {
    const h = await postgresSourceHarness(); h.onEffect(event => { if (event === 'management-health') h.store['gateways/shared-1'].retirementClaim = { operationId: 'foreign-retirement' }; });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined(); expect(h.deployment.spec.paused).toBe(true);
    expect(h.store['gateways/shared-1/releases/2']).toBeUndefined(); expect(h.events).not.toContain('resume-deployment');
  });
  it('keeps PostgreSQL repair fenced on a failed fresh management probe despite a complete Doctor acknowledgment', async () => {
    const h = await postgresSourceHarness(), original = h.deps.runKubectl.getMockImplementation()!;
    h.deps.runKubectl.mockImplementation(async (args, options) => {
      const result = await original(args, options);
      return args.includes('exec') && !options?.stdin?.includes('sourceRecoveryDiscoveryPreflight') ? { ...result, code: 1, stdout: '', stderr: 'management health unavailable' } : result;
    });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source management health unconfirmed');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.doctor.completedAt).toBeGreaterThan(0);
    expect(h.deployment.spec.paused).toBe(true); expect(h.store['gateways/shared-1/releases/2']).toBeUndefined();
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined(); expect(h.events).not.toContain('resume-deployment');
  });
  it('refuses an immutable release collision atomically without annotating failed placements or clearing the PostgreSQL fence', async () => {
    const h = await postgresSourceHarness(), collision = { gatewayId: 'shared-1', release: 2, createdAt: 1, createdBy: 'foreign', sourceRelease: 1,
      note: 'existing', payloadHash: 'existing', payload: structuredClone(h.payload) };
    h.store['gateways/shared-1/releases/2'] = structuredClone(collision);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('refusing to overwrite immutable history');
    expect(h.store['gateways/shared-1/releases/2']).toEqual(collision);
    expect(h.store['gateways/shared-1']).toMatchObject({ latestRelease: 1, desiredRelease: 1, liveRelease: 1 });
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeDefined(); expect(h.deployment.spec.paused).toBe(true);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery).toBeUndefined(); expect(h.events).not.toContain('resume-deployment');
  });
  async function postgresSourceSuccessor(completedDoctor = false) {
    const h = await postgresSourceHarness(); h.setAcknowledgment('none');
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    const fence = h.store['gateways/shared-1'].runtimeRestartFence;
    fence.doctor = { requestId: h.op.id, releaseKey: 'spent-recovery-image', startedAt: fence.installedImage.verifiedAt,
      ...(completedDoctor ? { completedAt: h.deps.now(), verifiedAgentIds: h.captured.postgresAgentStores!.map((store: { agentId: string }) => store.agentId) } : {}) };
    const prior = h.store['glmOperations/recover'];
    Object.assign(prior, { status: 'failed', completedAt: h.deps.now(), error: 'source repair is not ready; outcome remains fenced' });
    const before = structuredClone(prior), capturedFence = structuredClone(fence);
    Object.assign(h.op, { id: 'pg-successor', startedAt: h.deps.now() + 1, input: { gatewayId: 'shared-1', sourceRecovery: {
      ...(before.input.sourceRecovery as any), supersede: assertSharedSourceRecoveryPredecessor({ gatewayId: 'shared-1',
        operationId: 'recover', row: before, fence: capturedFence, source: before.input.sourceRecovery }),
    } } });
    h.store['glmOperations/pg-successor'] = structuredClone(h.op); h.setAcknowledgment('full');
    h.events.length = 0;
    return { ...h, before, capturedFence };
  }
  function mutateRootAfterCompletion(h: Awaited<ReturnType<typeof postgresSourceHarness>>, mutate: (root: any) => void) {
    h.ctx.assertActiveClaim.mockImplementation(async () => {
      if (h.store['glmOperations/recover'].sourceRuntimeRecovery) mutate(h.store['gateways/shared-1']);
    });
  }
  it.each(['paused', 'retired', 'gateway-class', 'owner', 'builder-slug'])('refuses completed PostgreSQL recovery unpause after %s root mutation', async changed => {
    const h = await postgresSourceHarness();
    mutateRootAfterCompletion(h, root => {
      if (changed === 'paused' || changed === 'retired') root.desiredStatus = changed;
      if (changed === 'gateway-class') root.gatewayClass = 'builder';
      if (changed === 'owner') root.ownerUid = 'foreign-owner';
      if (changed === 'builder-slug') root.builderSlug = 'foreign-user';
    });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('completed source recovery release custody changed');
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.completedAt).toBeGreaterThan(0);
    expect(h.deployment.spec.paused).toBe(true); expect(h.events).not.toContain('resume-deployment');
  });
  it('fails closed on a completed PostgreSQL recovery root that names another gateway before unpausing', async () => {
    const h = await postgresSourceHarness();
    mutateRootAfterCompletion(h, root => { root.gatewayId = 'foreign-shared'; });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toBeInstanceOf(MalformedRecordError);
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.completedAt).toBeGreaterThan(0);
    expect(h.deployment.spec.paused).toBe(true); expect(h.events).not.toContain('resume-deployment');
  });
  it('rechecks completed PostgreSQL source lifecycle after the Deployment unpause acknowledgment', async () => {
    const h = await postgresSourceHarness();
    h.onEffect(event => { if (event === 'resume-deployment') h.store['gateways/shared-1'].desiredStatus = 'paused'; });
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('completed source recovery release custody changed');
    expect(h.store['glmOperations/recover'].sourceRuntimeRecovery.completedAt).toBeGreaterThan(0);
  });
  it('transfers a validated PostgreSQL predecessor paused workload without replacing its Pod or losing its prior failure history', async () => {
    const h = await postgresSourceSuccessor();
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    expect(h.store['glmOperations/pg-successor'].sourceRuntimeRecovery.workload).toEqual(h.capturedFence.target.workload);
    expect(h.store['glmOperations/recover']).toEqual({ ...h.before, cancellationRequestedAt: h.deps.now(), sourceRecoverySupersededBy: h.op.id });
    expect(h.pod.metadata.uid).toBe('pod-uid'); expect(h.deployment.spec.paused).toBe(false);
    expect(h.events).toEqual(['pin-replicaset', 'pin-deployment', 'doctor-ack', 'management-health', 'resume-deployment']);
  });
  it('requires a distinct Doctor ACK after superseding completed Doctor with failed runtime readiness', async () => {
    const h = await postgresSourceSuccessor(true), oldDoctor = structuredClone(h.capturedFence.doctor);
    h.setAcknowledgment('none');
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow('source repair is not ready');
    expect(h.store['gateways/shared-1'].runtimeRestartFence.doctor).toEqual({ requestId: 'pg-successor' });
    expect(h.store['glmOperations/pg-successor'].sourceRuntimeRecovery).toBeUndefined();
    expect(h.store['glmOperations/pg-successor'].input.sourceRecovery.supersede.fence.doctor).toEqual(oldDoctor);
    expect(h.events).not.toContain('doctor-ack'); expect(h.events).not.toContain('resume-deployment');
    h.setAcknowledgment('full');
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    const doctor = h.store['glmOperations/pg-successor'].sourceRuntimeRecovery.doctor;
    expect(doctor.requestId).toBe('pg-successor');
    expect(doctor.completedAt).toBeGreaterThan(oldDoctor.completedAt);
    expect(doctor.verifiedAgentIds).toEqual(h.captured.postgresAgentStores!.map((store: { agentId: string }) => store.agentId));
    expect(h.store['glmOperations/pg-successor'].input.sourceRecovery.supersede.fence.doctor).toEqual(oldDoctor);
    expect(h.store['gateways/shared-1'].runtimeRestartFence).toBeUndefined();
  });
  it.each(['deployment', 'replicaset', 'fence'])('refuses a changed %s when inheriting a PostgreSQL predecessor pause', async changed => {
    const h = await postgresSourceSuccessor();
    if (changed === 'deployment') {
      h.deployment.metadata.uid = 'replacement-deployment';
      (h.replicaSet.metadata as any).ownerReferences[0].uid = 'replacement-deployment';
    }
    if (changed === 'replicaset') {
      h.replicaSet.metadata.uid = 'replacement-replicaset'; h.pod.metadata.ownerReferences[0].uid = 'replacement-replicaset';
    }
    if (changed === 'fence') h.store['gateways/shared-1'].runtimeRestartFence.target.workload.deploymentUid = 'foreign';
    const before = structuredClone(h.store);
    await expect(recoverSharedSourceRuntime(h.deps, h.op, h.ctx)).rejects.toThrow();
    expect(h.store).toEqual(before); expect(h.events).toEqual([]); expect(h.deployment.spec.paused).toBe(true);
  });
  it('rearms a rolled-back placement from the completed source repair journal', async () => {
    const h = await postgresSourceHarness();
    const failedId = continuousPlacementMigrationOperationId({ uid: 'source-0', builderSlug: 'jdog99', fromGatewayId: 'shared-1', toGatewayId: 'shared-2', sourceAssignmentEpoch: 1 });
    h.store[`glmOperations/${failedId}`].error = 'a different maintenance failure';
    await recoverSharedSourceRuntime(h.deps, h.op, h.ctx);
    const root = h.store['gateways/shared-1'], payload = h.payload;
    root.liveRelease = 2;
    h.store['glmGateways/shared-1'] = { docKind: 'runtime', gatewayId: 'shared-1', runtime: 'cluster', release: 2, lifecycle: 'serving',
      heartbeat: { status: 'ready', lastHeartbeatAt: h.deps.now(), mountedCustomers: [], migratingIn: [] },
      helm: { imageRepository: payload.imageRepository, imageTag: payload.imageTag } };
    h.store['gateways/shared-2'] = { ...root, gatewayId: 'shared-2', desiredStatus: 'running', latestRelease: 1, desiredRelease: 1, liveRelease: 1 };
    h.store['gateways/shared-2/releases/1'] = { gatewayId: 'shared-2', release: 1, createdAt: 1, createdBy: 'operator', sourceRelease: null, note: null,
      payloadHash: releasePayloadHash(payload), payload };
    h.store['glmGateways/shared-2'] = { docKind: 'runtime', gatewayId: 'shared-2', runtime: 'cluster', release: 1, lifecycle: 'serving',
      heartbeat: { status: 'ready', lastHeartbeatAt: h.deps.now(), mountedCustomers: [], migratingIn: [] } };
    const { userSlug, ...failedInput } = h.store[`glmOperations/${failedId}`].input;
    const request = { ...failedInput, builderSlug: userSlug, operationId: failedId };
    await expect(enqueuePlacementMigration({ store: h.deps.store, now: h.deps.now, platformArtifact: payload }, request)).resolves.toBe(failedId);
    expect(h.store[`glmOperations/${failedId}`].status).toBe('pending');
  });
});
