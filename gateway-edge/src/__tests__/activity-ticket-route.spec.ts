import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ authorize: vi.fn(), mint: vi.fn() }));
vi.mock('@octogee/core/http/auth', () => ({ requireAuth: (req: { uid: string }, _res: unknown, next: () => void) => { req.uid = 'member'; next(); } }));
vi.mock('../lib/activity-conversation.js', () => ({ resolveActivityConversation: h.authorize }));
vi.mock('../lib/gateway-ticket.js', () => ({ mintTicket: h.mint }));
vi.mock("@octogee/core/platform-state", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
    platformStateStoreFromEnvironment: () => createDocumentFixtureStore(new Map()),
  };
});
const { default: router } = await import('../routes/openclaw.js');
const threadRootPostId = 'r'.repeat(26);
const scope = { gatewayId: 'shared-123456789abc', ownerUid: 'owner', channelId: 'c'.repeat(26), threadRootPostId, expectedAgentId: 'octogee-alice-proj-web', sessionKey: `agent:octogee-alice-proj-web:mattermost:group:${'c'.repeat(26)}` };
function app() { const a = express(); a.use(express.json()); a.use('/api/openclaw', router); return a; }
beforeEach(() => { h.authorize.mockReset().mockResolvedValue(scope); h.mint.mockReset().mockResolvedValue({ ticket: 'ticket' }); });
describe('native Activity tickets', () => {
  it('mints a channel-scoped ticket without a selected thread', async () => {
    const { threadRootPostId: _thread, ...channelScope } = scope;
    h.authorize.mockResolvedValue(channelScope);
    const result = await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId });
    expect(result.status).toBe(200); expect(result.body.sessionKey).toBe(scope.sessionKey);
    expect(h.authorize).toHaveBeenCalledWith({ users: expect.anything(), uid: 'member', channelId: scope.channelId });
    expect(h.mint.mock.calls[0][0].payload).toEqual({ ownerUid: scope.ownerUid, channelId: scope.channelId, expectedAgentId: scope.expectedAgentId, sessionKey: scope.sessionKey });
  });
  it('refuses a malformed thread root instead of falling back to the channel', async () => {
    expect((await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId, threadRootPostId: 'bad' })).status).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled(); expect(h.mint).not.toHaveBeenCalled();
  });
  it('mints the exact verified selected thread rather than its base room', async () => {
    const threadRootPostId = 'r'.repeat(26);
    const selected = scope;
    h.authorize.mockResolvedValue(selected);
    const result = await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId, threadRootPostId });
    expect(result.status).toBe(200); expect(result.body.sessionKey).toBe(selected.sessionKey);
    expect(h.authorize).toHaveBeenCalledWith(expect.objectContaining({ channelId: scope.channelId, threadRootPostId }));
    expect(h.mint.mock.calls[0][0].payload).toMatchObject({ threadRootPostId, sessionKey: selected.sessionKey });
  });
  it('mints the exact server-derived channel scope without activation or control grants', async () => {
    const result = await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId, threadRootPostId });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ gatewayId: scope.gatewayId, sessionKey: scope.sessionKey, wsTicket: 'ticket' });
    expect(h.mint).toHaveBeenCalledWith({ uid: 'member', gatewayId: scope.gatewayId, purpose: 'openclaw-ws', payload: { ownerUid: scope.ownerUid, channelId: scope.channelId, threadRootPostId, expectedAgentId: scope.expectedAgentId, sessionKey: scope.sessionKey } });
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it.each([{ channelId: 'bad' }, { channelId: scope.channelId, expectedAgentId: 'other' }, { channelId: scope.channelId, sessionKey: 'forged' }])('rejects client-assigned authority %j', async body => {
    expect((await request(app()).post('/api/openclaw/ticket').send(body)).status).toBe(400); expect(h.mint).not.toHaveBeenCalled();
  });
  it('does not mint for a removed member', async () => {
    h.authorize.mockResolvedValue(null); expect((await request(app()).post('/api/openclaw/ticket').send({ channelId: scope.channelId, threadRootPostId })).status).toBe(403); expect(h.mint).not.toHaveBeenCalled();
  });
});
