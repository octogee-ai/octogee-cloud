import { describe, it, expect } from 'vitest';
import { MalformedRecordError } from '@octogee/core/platform-state';
import { createDocumentFixtureStore } from '@octogee/core/testing/journal-store';
import {
  resolveGatewayAssignment,
  resolveGatewayUrl,
  GatewayResolveError,
} from '../openclaw/gateway-resolver.js';

type DocData = Record<string, unknown>;

function mkStore(docs: Record<string, DocData>) {
  return createDocumentFixtureStore(docs);
}

const URL_A =
  'http://octogee-gateway-gw-a.octogee-test.svc.cluster.local:18789';

function durableRoot(gatewayId: string, overrides: Record<string, unknown> = {}) {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: 'test',
    updatedAt: 1,
    updatedBy: 'test',
    desiredRelease: 1,
    latestRelease: 1,
    liveRelease: 1,
    desiredStatus: 'running',
    configSchemaVersion: 1,
    profile: 'standard',
    gatewayClass: 'shared',
    imageProfile: 'standard',
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function servingRuntime(
  gatewayId: string,
  release: number,
  heartbeat: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    docKind: 'runtime',
    gatewayId,
    release,
    lifecycle: 'serving',
    createdAt: 1,
    createdByOperationId: null,
    retiredAt: null,
    retireReason: null,
    helm: {
      releaseName: `octogee-gw-${gatewayId}`,
      deploymentName: `octogee-gateway-${gatewayId}`,
      gatewayServiceName: `gateway-${gatewayId}`,
      gatewayEdgeServiceName: `gateway-edge-${gatewayId}`,
      serviceAccountName: `octogee-gw-${gatewayId}`,
      imageRepository: 'us-central1-docker.pkg.dev/octogee/octogee/gateway',
      imageTag: 'abc1234',
      replicas: 1,
      availableReplicas: 1,
      lastAppliedAt: 1,
    },
    heartbeat: {
      status: 'ready',
      lastHeartbeatAt: 1,
      version: 'abc1234',
      openclawVersion: null,
      internalUrl: null,
      startedAt: 1,
      mountedCustomers: [],
      migratingIn: [],
      ...heartbeat,
    },
    lastError: { message: null, at: null },
    ...overrides,
  };
}

function servingAssignment(
  gatewayId: string,
  uid: string,
  _release: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    uid,
    slug: 'alice',
    gatewayId,
    source: 'migrate-user',
    state: 'serving',
    epoch: 1,
    updatedAt: 1,
    updatedByOperationId: null,
    ...overrides,
  };
}

const PROVISIONED = { provisioning: { openclaw: { gatewayId: 'gw-a' } } };

describe('resolveGatewayUrl — glm-heartbeat / revision resolution (no round-robin alias)', () => {
  it('refuses a gateway without a durable root instead of dialing a legacy heartbeat', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'glmGateways/gw-a': { gatewayId: 'gw-a', heartbeat: { internalUrl: URL_A } },
    });
    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-not-registered',
    });
  });

  it('GatewayDoc + serving assignment: resolves via the bare runtime heartbeat', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': servingAssignment('gw-a', 'u1', 1),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });
    const r = await resolveGatewayUrl({ store, uid: 'u1' });
    expect(r).toEqual({ gatewayId: 'gw-a', url: URL_A });
  });

  it('GatewayDoc, no assignment: resolves via the bare runtime heartbeat', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });
    const r = await resolveGatewayUrl({ store, uid: 'u1' });
    expect(r.url).toBe(URL_A);
  });

  it('routes only an empty retired co-owner mirror on the desired root', async () => {
    const empty = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a', { coOwnerUids: [] }),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });
    await expect(resolveGatewayUrl({ store: empty, uid: 'u1' })).resolves.toMatchObject({
      gatewayId: 'gw-a',
      url: URL_A,
    });

    const nonEmpty = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a', { coOwnerUids: ['uid-former-helper'] }),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });
    await expect(resolveGatewayUrl({ store: nonEmpty, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-root-invalid',
    });
  });

  it('GatewayDoc with NO runtime realization: fails loud, never dials', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
    });
    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-not-registered',
    });
  });

  it('NEVER honors a flat internalUrl contaminating a backfilled GatewayDoc', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a', {
        internalUrl: 'http://WRONG-flat:18789',
      }),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });
    const r = await resolveGatewayUrl({ store, uid: 'u1' });
    expect(r.url).toBe(URL_A);
  });

  it('fails closed on an incomplete root instead of falling back to the legacy glm heartbeat', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': { gatewayId: 'gw-a', internalUrl: 'http://WRONG-flat:18789' },
      'glmGateways/gw-a': { heartbeat: { internalUrl: URL_A } },
    });

    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it.each([
    ['an incomplete assignment', { gatewayId: 'gw-a' }],
    ['an assignment with an invalid state', servingAssignment('gw-a', 'u1', 1, { state: 'unknown' })],
    ['an assignment for another gateway', servingAssignment('gw-a', 'u1', 1, { gatewayId: 'other' })],
  ])('fails closed on %s instead of routing it', async (_label, assignment) => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': assignment,
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it('rejects a non-serving assignment instead of routing it', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': servingAssignment('gw-a', 'u1', 1, { state: 'migrating' }),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('fails closed on a runtime doc with a foreign gateway identity', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }, { gatewayId: 'other' }),
    });

    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it('rejects a runtime doc with a failed lifecycle', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }, { lifecycle: 'failed' }),
    });

    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('rejects a retired durable root even when its runtime still has an internal URL', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a', { desiredStatus: 'retired' }),
      'glmGateways/gw-a': servingRuntime('gw-a', 1, { internalUrl: URL_A }),
    });

    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('honors overrideUrl (sidecar mode) and skips the gateway reads', async () => {
    const store = mkStore({ 'users/u1': PROVISIONED });
    const r = await resolveGatewayUrl({
      store,
      uid: 'u1',
      overrideUrl: 'http://127.0.0.1:18789',
    });
    expect(r).toEqual({ gatewayId: 'gw-a', url: 'http://127.0.0.1:18789' });
  });

  it('still requires user provisioning when overrideUrl is set', async () => {
    await expect(
      resolveGatewayUrl({ store: mkStore({}), uid: 'u1', overrideUrl: 'http://127.0.0.1:18789' }),
    ).rejects.toMatchObject({ code: 'user-not-provisioned' });
  });

  it('throws gateway-url-unresolved when the runtime heartbeat has no internalUrl', async () => {
    const store = mkStore({
      'users/u1': PROVISIONED,
      'gateways/gw-a': durableRoot('gw-a'),
      'glmGateways/gw-a': servingRuntime('gw-a', 1),
    });
    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toThrow(GatewayResolveError);
    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('throws user-not-provisioned when the user doc lacks gatewayId', async () => {
    const store = mkStore({ 'users/u1': { provisioning: { openclaw: {} } } });
    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'user-not-provisioned',
    });
  });

  it('throws user-not-provisioned when the user doc is missing', async () => {
    await expect(resolveGatewayUrl({ store: mkStore({}), uid: 'u1' })).rejects.toMatchObject({
      code: 'user-not-provisioned',
    });
  });

  it('throws gateway-not-registered when the durable root is missing', async () => {
    const store = mkStore({
      'users/u1': { provisioning: { openclaw: { gatewayId: 'gw-missing' } } },
    });
    await expect(resolveGatewayUrl({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-not-registered',
    });
  });
});

describe('resolveGatewayAssignment — tenant serving boundary', () => {
  const user = { username: 'alice', ...PROVISIONED };

  it('requires a serving assignment on a durable gateway', async () => {
    const store = mkStore({
      'users/u1': user,
      'gateways/gw-a': durableRoot('gw-a'),
    });

    await expect(resolveGatewayAssignment({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('requires the durable assignment to be serving for that user and gateway', async () => {
    const store = mkStore({
      'users/u1': user,
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': servingAssignment('gw-a', 'u1', 1, {
        state: 'migrating',
      }),
    });

    await expect(resolveGatewayAssignment({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-url-unresolved',
    });
  });

  it('resolves a serving assignment on a running durable root', async () => {
    const store = mkStore({
      'users/u1': user,
      'gateways/gw-a': durableRoot('gw-a'),
      'gateways/gw-a/assignments/u1': servingAssignment('gw-a', 'u1', 1),
    });

    await expect(resolveGatewayAssignment({ store, uid: 'u1' })).resolves.toEqual({ gatewayId: 'gw-a' });
  });

  it('refuses a user whose gateway has no durable root', async () => {
    const store = mkStore({ 'users/u1': user });

    await expect(resolveGatewayAssignment({ store, uid: 'u1' })).rejects.toMatchObject({
      code: 'gateway-not-registered',
    });
  });
});

it('reports a draining assignment as a workspace move', async () => {
  const store = mkStore({
    'users/u1': PROVISIONED,
    'gateways/gw-a': durableRoot('gw-a', { desiredStatus: 'draining' }),
  });
  await expect(resolveGatewayAssignment({ store, uid: 'u1' })).rejects.toMatchObject({ code: 'workspace-moving' });
});
