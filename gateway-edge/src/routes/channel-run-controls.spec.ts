import { createServer } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChannelRunControlsRouter } from './channel-run-controls.js';

const native = vi.hoisted(() => ({ call: vi.fn(), dispose: vi.fn(), close: vi.fn(), open: vi.fn() }));
vi.mock('@octogee/core/http/auth', () => ({
  requireAuthenticatedUid: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.uid = 'signed-in';
    next();
  },
}));
vi.mock('@octogee/core/http/authenticated-request-limit', () => ({
  authenticationFailureLimit: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authenticatedRequestLimit: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/authenticated-upstream', () => ({ openAuthenticatedUpstream: native.open }));
vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc', () => ({ attachUpstreamRpcClient: () => native }));

const gatewayId = 'gw-alice';
const channelId = 'c'.repeat(26);
const callerMmUserId = 'a'.repeat(26);
const expectedAgentId = 'octogee-alice-proj-web-coach';
const sessionKey = `agent:${expectedAgentId}:mattermost:group:${channelId}`;
const path = `/api/g/${gatewayId}/chat-run?channelId=${channelId}&runId=run-1`;
const getChannelRunControlAccess = vi.fn();
const app = express();
app.use('/api/g/:gatewayId/chat-run', createChannelRunControlsRouter({ broker: { getChannelRunControlAccess } }));
const server = createServer(app);

beforeAll(() => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)));
afterAll(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GATEWAY_ID', gatewayId);
  getChannelRunControlAccess.mockResolvedValue({ gatewayId, ownerUid: 'owner', callerMmUserId, channelId, expectedAgentId, sessionKey, isOwner: false });
  native.open.mockResolvedValue({ close: native.close });
});
afterEach(() => vi.unstubAllEnvs());

describe('channel composer run control', () => {
  it('uses the native run origin for a member and stops that exact channel run', async () => {
    native.call.mockResolvedValueOnce({ ok: true, result: { starterMmUserId: callerMmUserId } });
    native.call.mockResolvedValueOnce({ ok: true, result: { status: 'aborted', abortedRunId: 'run-1' } });
    await request(server).post(path).expect(200, { status: 'aborted' });
    expect(getChannelRunControlAccess).toHaveBeenCalledWith('signed-in', channelId);
    expect(native.call.mock.calls).toEqual([
      ['octogee.activity.channelRunOrigin', { sessionKey, runId: 'run-1' }],
      ['sessions.abort', { key: sessionKey, agentId: expectedAgentId, runId: 'run-1' }],
    ]);
  });

  it('finds the active channel run when an owner opens the composer mid-run', async () => {
    getChannelRunControlAccess.mockResolvedValueOnce({
      gatewayId, ownerUid: 'owner', callerMmUserId, channelId, expectedAgentId, sessionKey, isOwner: true,
    });
    native.call.mockResolvedValueOnce({ ok: true, result: { starterMmUserId: null } });
    native.call.mockResolvedValueOnce({ ok: true, result: { session: { activeRunIds: ['run-1'] } } });
    await request(server).get(`/api/g/${gatewayId}/chat-run?channelId=${channelId}`).expect(200, { allowed: true, runId: 'run-1' });
    expect(native.call).toHaveBeenLastCalledWith('sessions.describe', { key: sessionKey, agentId: expectedAgentId });
  });

  it('finds the starter’s active channel run without relying on the session projection', async () => {
    native.call.mockResolvedValueOnce({ ok: true, result: { runId: 'run-1', starterMmUserId: callerMmUserId } });
    await request(server).get(`/api/g/${gatewayId}/chat-run?channelId=${channelId}`).expect(200, { allowed: true, runId: 'run-1' });
    expect(native.call).toHaveBeenCalledExactlyOnceWith('octogee.activity.channelRunOrigin', { sessionKey });
  });

  it('lets a verified owner act without matching the run starter', async () => {
    getChannelRunControlAccess.mockResolvedValueOnce({ gatewayId, ownerUid: 'owner', callerMmUserId, channelId, expectedAgentId, sessionKey, isOwner: true });
    native.call.mockResolvedValueOnce({ ok: true, result: { status: 'aborted', abortedRunId: 'run-1' } });
    await request(server).post(path).expect(200);
    expect(native.call).toHaveBeenCalledExactlyOnceWith('sessions.abort', { key: sessionKey, agentId: expectedAgentId, runId: 'run-1' });
  });

  it('never sends an abort for a bystander or an unauthorized channel', async () => {
    native.call.mockResolvedValueOnce({ ok: true, result: { starterMmUserId: 'b'.repeat(26) } });
    await request(server).post(path).expect(403);
    expect(native.call).toHaveBeenCalledExactlyOnceWith('octogee.activity.channelRunOrigin', { sessionKey, runId: 'run-1' });
    getChannelRunControlAccess.mockResolvedValueOnce(null);
    await request(server).post(path).expect(403);
    expect(native.open).toHaveBeenCalledTimes(1);
  });
});
