import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenClawRuntimeBrokerRoutes } from './openclaw-runtime-broker.js';
import { createDocumentFixtureStore } from '@octogee/core-testing/journal-store';
import { createTenantEnforcementMiddleware } from '../middleware/tenant-enforcement.js';
import { RecordingDocuments } from '../test-helpers/recording-documents.js';
const { authorize, authorizeRunControl } = vi.hoisted(() => ({ authorize: vi.fn(), authorizeRunControl: vi.fn() }));
vi.mock('@octogee/core/channels/activity-conversation', () => ({
  resolveActivityConversation: authorize,
  resolveChannelRunControlConversation: authorizeRunControl,
}));
const threadRootPostId = 'r'.repeat(26);
const gatewayId = 'b-alice';
const memberMmUserId = 'm'.repeat(26);
const runControlPath = '/internal/openclaw/activity/run-control-access';
const scope = { gatewayId, ownerUid: 'owner', channelId: 'c'.repeat(26), threadRootPostId, expectedAgentId: 'octogee-alice-proj-web', sessionKey: `agent:octogee-alice-proj-web:mattermost:group:${'c'.repeat(26)}` };
function harness(
  payloadPatch: Record<string, unknown> = {},
  ownerGateway = gatewayId,
  tenant: Express.Request['boundTenant'] = { kind: 'gateway', gatewayId, ownerUid: 'owner' },
) {
  const { gatewayId: _, ...payload } = scope;
  const ticket = { uid: 'member', gatewayId, purpose: 'openclaw-ws', expiresAt: Date.now() + 30_000, payload: { ...payload, ...payloadPatch } };
  const docs = new RecordingDocuments({
    'gatewayTickets/ticket': ticket,
    'users/owner': { provisioning: { openclaw: { gatewayId: ownerGateway } } },
    'users/member': { mattermost: { userId: memberMmUserId }, provisioning: { openclaw: { gatewayId: 'b-member' } } },
    [`gateways/${gatewayId}`]: { gatewayId, desiredRelease: 1, latestRelease: 1, liveRelease: 1, desiredStatus: 'running', configSchemaVersion: 1, profile: 'isolated', gatewayClass: 'isolated', imageProfile: 'isolated', sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: { controlIdentity: 'per-user', controlUiEnabled: true }, ownerUid: 'owner', builderSlug: 'alice', modelBrokerLimits: null, preemption: null },
    [`glmGateways/${gatewayId}`]: { docKind: 'runtime', gatewayId, release: 1, lifecycle: 'serving', heartbeat: { internalUrl: 'ws://native.internal:18789' } },
  });
  const store = createDocumentFixtureStore(docs);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.boundTenant = tenant; next(); });
  app.use(rateLimit({ limit: 60 }), createTenantEnforcementMiddleware({
    store, readFlowGateway: async () => null,
    enforceWhen: req => req.path === runControlPath,
    onAccess: () => {},
  }));
  app.use('/internal/openclaw', createOpenClawRuntimeBrokerRoutes({ store, readSizingKey: async () => null }));
  const ticketWrites = () => docs.writes.filter((write) => write.path.startsWith('gatewayTickets/'));
  return {
    ticketWrites,
    post: () => request(app).post('/internal/openclaw/ws/redeem').send({ ticketId: 'ticket', purpose: 'openclaw-ws' }),
    access: () => request(app).post('/internal/openclaw/activity/conversation-access').send({ uid: 'member', channelId: scope.channelId, threadRootPostId }),
    runControl: (actor: { senderId?: string; uid?: string; gatewayId?: string }) => request(app).post(runControlPath).send({ ...actor, channelId: scope.channelId }),
  };
}
beforeEach(() => {
  authorize.mockReset().mockResolvedValue(scope);
  authorizeRunControl.mockReset().mockResolvedValue({ ...scope, callerMmUserId: memberMmUserId, isOwner: false });
});
describe('channel-scoped native Activity authority', () => {
  it('redeems once against the selected owner/agent without issuing a posting grant', async () => {
    const h = harness(); const result = await h.post();
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ uid: 'member', expectedAgentId: scope.expectedAgentId, activityConversation: scope });
    expect(result.body.voiceGrant).toBeUndefined(); expect(h.ticketWrites()).toEqual([{ path: 'gatewayTickets/ticket', data: undefined }]);
    expect((await h.post()).status).toBe(401);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ uid: 'member', channelId: scope.channelId, threadRootPostId }));
  });
  it.each([{ ownerUid: 'foreign' }, { expectedAgentId: 'other' }, { sessionKey: 'forged' }, { channelId: 'bad' }, { extra: true }])('refuses forged persisted scope %j', async patch => {
    const h = harness(patch); expect((await h.post()).status).toBe(403); expect(h.ticketWrites()).toEqual([]);
  });
  it('rechecks membership and owner assignment before consuming the ticket', async () => {
    const h = harness(); authorize.mockResolvedValueOnce(null);
    expect((await h.post()).status).toBe(403); expect(h.ticketWrites()).toEqual([]);
    const moved = harness({}, 'b-moved'); expect((await moved.post()).status).toBe(403); expect(moved.ticketWrites()).toEqual([]);
  });
  it('keeps periodic access checks bound to this gateway', async () => {
    const h = harness(); expect((await h.access()).body).toEqual(scope);
    authorize.mockResolvedValueOnce({ ...scope, gatewayId: 'b-foreign' }); expect((await h.access()).status).toBe(403);
    authorize.mockResolvedValueOnce(null); expect((await h.access()).status).toBe(403);
  });
  it('binds run controls to the calling gateway and the verified Mattermost identity', async () => {
    const h = harness();
    expect((await h.runControl({ uid: 'member' })).body).toMatchObject({ authorized: true, isOwner: false });
    expect((await h.runControl({ senderId: memberMmUserId })).body).toMatchObject({ authorized: true, callerMmUserId: memberMmUserId });
    expect(authorizeRunControl).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'member', channelId: scope.channelId }), expect.anything());
    expect((await h.runControl({ uid: 'owner', senderId: memberMmUserId })).status).toBe(400);
    authorizeRunControl.mockResolvedValueOnce({ ...scope, gatewayId: 'b-foreign', callerMmUserId: memberMmUserId, isOwner: true });
    expect((await h.runControl({ uid: 'member' })).status).toBe(403);
    authorizeRunControl.mockResolvedValueOnce({ ...scope, callerMmUserId: 'o'.repeat(26), isOwner: true });
    expect((await h.runControl({ senderId: memberMmUserId })).status).toBe(403);
  });
  it('rejects a foreign gateway claim or a platform caller before running channel authorization', async () => {
    const h = harness();
    expect((await h.runControl({ uid: 'member', gatewayId: 'b-foreign' })).status).toBe(403);
    const platform = harness({}, gatewayId, { kind: 'platform', actor: 'cron' });
    expect((await platform.runControl({ uid: 'member' })).status).toBe(403);
    expect(authorizeRunControl).not.toHaveBeenCalled();
  });
});
