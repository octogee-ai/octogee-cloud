import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { BoundTenant } from '../lib/sa-to-tenant.js';
import { createDocumentFixtureStore } from '@octogee/core-testing/journal-store';
import { NO_BROKER_RECORDS, type BrokerRecords } from '../lib/broker-records.js';
import { createFleetBrokerRoutes } from './fleet-broker.js';

function harness(bound: BoundTenant | null, greeting: unknown) {
  const user = { username: 'alice', provisioning: { openclaw: { gatewayId: 'shared-test', status: 'complete', greeting } } };
  const writes = vi.fn(async () => { throw new Error('Snapshot must not write'); });
  const docs: Record<string, Record<string, unknown>> = { 'users/uid-alice': user };
  const records: BrokerRecords = {
    ...NO_BROKER_RECORDS,
    userDocuments: { ...NO_BROKER_RECORDS.userDocuments, account: async (uid) => docs[`users/${uid}`] },
    recordUsageEvent: writes,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (bound) req.boundTenant = bound;
    next();
  });
  app.use('/internal/fleet', createFleetBrokerRoutes({ store: createDocumentFixtureStore(docs), records }));
  return { app, user, writes };
}

describe('user-snapshot greeting receipt wire projection', () => {
  it('returns wire true for an actual scheduling receipt without changing authoritative state', async () => {
    const receipt = { ok: true, jobId: '71dd1a31-9202-476d-a306-bef98550f694', at: { seconds: 1790611043 } };
    const { app, user, writes } = harness({ kind: 'gateway', gatewayId: 'shared-test' }, receipt);
    const before = structuredClone(user);
    const response = await request(app).post('/internal/fleet/user-snapshot').send({ uid: 'uid-alice' });
    expect(response.status).toBe(200);
    expect(response.body.user.greetingPosted).toBe(true);
    expect(user).toEqual(before);
    expect(user.provisioning.openclaw.greeting).toBe(receipt);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([undefined, { ok: false, jobId: 'failed' }, { ok: true }])('does not fabricate wire success from %j', async greeting => {
    const { app, writes } = harness({ kind: 'gateway', gatewayId: 'shared-test' }, greeting);
    const response = await request(app).post('/internal/fleet/user-snapshot').send({ uid: 'uid-alice' });
    expect(response.status).toBe(200);
    expect(response.body.user.greetingPosted).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([null, { kind: 'platform', actor: 'cron' }, { kind: 'gateway', gatewayId: 'foreign' }] as Array<BoundTenant | null>)('preserves the bound gateway authorization boundary for %j', async bound => {
    const { app, writes } = harness(bound, { ok: true, jobId: 'existing' });
    const response = await request(app).post('/internal/fleet/user-snapshot').send({ uid: 'uid-alice' });
    expect(response.status).toBe(403);
    expect(response.body.user).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
  });
});
