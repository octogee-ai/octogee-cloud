import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@octogee/core/internal-fetch', () => ({ internalFetch: h.fetch }));
import { resolveToolConversationForUid, resolveToolChannelForUid, resolveToolControlForUid } from './tool-conversation.js';
const channelId = 'a'.repeat(26);
const threadRootPostId = 'r'.repeat(26);
const args = { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, expectedAgentId: 'octogee-alice-coach', env: { OPENCLAW_RUNTIME_BROKER_URL: 'http://octogee-api:3001' } };
const answer = { uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, workspaceSlug: 'alice', agentId: args.expectedAgentId, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${channelId}`, callerMmUserId: 'b'.repeat(26) };
describe('tool conversation broker', () => {
  it('obtains canonical channel-tool custody without a reply root or a member credential', async () => {
    const { threadRootPostId: _root, ...channel } = answer;
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...channel, mmToken: 'private' })));
    await expect(resolveToolChannelForUid(args)).resolves.toEqual(channel);
    const [, init, options] = h.fetch.mock.lastCall as [string, RequestInit, Record<string, unknown>];
    expect(JSON.parse(init.body as string)).toEqual({ uid: args.uid, gatewayId: args.gatewayId, channelId, purpose: 'channel-tools' });
    expect(options).toMatchObject({ requireProjectedToken: true });
  });
  it.each([{ threadRootPostId }, { agentId: 'foreign' }, { sessionKey: 'agent:foreign:main' }, { channelId: 'foreign' }, { callerMmUserId: 'short' }])('refuses malformed channel-tool custody %j', async patch => {
    const { threadRootPostId: _root, ...channel } = answer;
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...channel, ...patch })));
    await expect(resolveToolChannelForUid(args)).rejects.toThrow('invalid context');
  });
  it('cannot turn an unbound VM/theme control context into session custody', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveToolControlForUid(args)).rejects.toThrow('invalid context');
    const { agentId: _agent, sessionKey: _session, threadRootPostId: _root, ...control } = answer;
    h.fetch.mockResolvedValue(new Response(JSON.stringify(control)));
    await expect(resolveToolControlForUid(args)).resolves.toEqual(control);
    h.fetch.mockResolvedValue(new Response(JSON.stringify(control)));
    await expect(resolveToolConversationForUid(args)).rejects.toThrow('invalid context');
  });
  it('uses projected service authentication and returns the canonical server context', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    await expect(resolveToolConversationForUid(args)).resolves.toEqual(answer);
    const [url, init, options] = h.fetch.mock.calls[0] as [string, RequestInit, Record<string, unknown>];
    expect(new URL(url).pathname).toBe('/internal/openclaw-control/tool-conversation');
    expect(init).toMatchObject({ body: JSON.stringify({ uid: 'u', gatewayId: 'b-alice', channelId, threadRootPostId, purpose: 'conversation' }), redirect: 'error' });
    expect(options).toMatchObject({ requireProjectedToken: true });
  });
  it('never carries a member credential into the sidecar', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, mmToken: 'm'.repeat(26) })));
    await expect(resolveToolConversationForUid(args)).resolves.not.toHaveProperty('mmToken');
  });
  it.each([{ uid: 'foreign' }, { gatewayId: 'b-other' }, { agentId: 'foreign' }, { sessionKey: 'agent:foreign:main' }, { callerMmUserId: 'short' }])('rejects malformed or cross-context answers %j', async (patch) => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ...answer, ...patch })));
    await expect(resolveToolConversationForUid(args)).rejects.toThrow();
  });
  it('does not turn a revoked conversation into usable context', async () => {
    h.fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(resolveToolConversationForUid(args)).rejects.toMatchObject({ status: 403 });
  });
});
