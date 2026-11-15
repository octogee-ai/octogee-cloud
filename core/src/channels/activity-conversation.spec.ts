import { describe, expect, it, vi } from 'vitest';
import { resolveActivityConversation } from './activity-conversation.js';
import { ChannelSessionMattermostError } from './channel-session-model-control.js';
import type { PlatformUserRecord } from '../platform-state/index.js';

const channelId = 'c'.repeat(26);
const threadRootPostId = 'r'.repeat(26);
const uid = 'member';
const gatewayId = 'shared-123456789abc';
function fixture(type = 'P') {
  const target = { ownerUid: 'owner', workspaceSlug: 'alice', agentId: 'octogee-alice-proj-web', agentMmUserId: 'a'.repeat(26), projectId: 'web' };
  const client = { getJson: vi.fn(async (path: readonly string[]): Promise<unknown> => path[0] === 'posts'
    ? { id: threadRootPostId, channel_id: channelId, root_id: '', delete_at: 0 }
    : path.length === 2
    ? { id: channelId, type, delete_at: 0 }
    : { channel_id: channelId, user_id: target.agentMmUserId }), postJson: vi.fn(async () => null), uploadFiles: vi.fn(async () => ({ file_infos: [] })), getCurrentUserId: vi.fn(async () => 'u'.repeat(26)), listChannelPosts: vi.fn(async () => ({ posts: [], reachedEnd: true })) };
  const authorize = vi.fn(async () => ({ forbidden: false as const, target, client, callerMmUserId: 'u'.repeat(26) }));
  const owner = { uid: 'owner', slug: 'alice', gateway: { gatewayId }, accountLifecycle: null } as unknown as PlatformUserRecord;
  const users = { get: vi.fn(async () => owner) };
  return { users, authorize, client, target };
}
describe('native Activity conversation', () => {
  it('shares channel memory across selected roots while retaining the authorized display root', async () => {
    const f = fixture();
    const read = f.client.getJson.getMockImplementation()!;
    f.client.getJson.mockImplementation(path => path[0] === 'posts'
      ? Promise.resolve({ id: path[1], channel_id: channelId, root_id: '', delete_at: 0 })
      : read(path));
    const first = await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId });
    const second = await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId: 's'.repeat(26) });
    expect([first?.sessionKey, second?.sessionKey]).toEqual([
      `agent:${f.target.agentId}:mattermost:group:${channelId}`,
      `agent:${f.target.agentId}:mattermost:group:${channelId}`,
    ]);
    expect([first?.threadRootPostId, second?.threadRootPostId]).toEqual([threadRootPostId, 's'.repeat(26)]);
  });
  it.each([['O', 'channel'], ['P', 'group']])('uses the native %s conversation key for the whole channel without a selected thread', async (type, kind) => {
    const f = fixture(type);
    expect((await resolveActivityConversation({ ...f, uid, channelId }))?.sessionKey).toBe(`agent:${f.target.agentId}:mattermost:${kind}:${channelId}`);
    expect(f.client.getJson).not.toHaveBeenCalledWith(['posts', expect.anything()]);
  });
  it('still requires a selected thread for a direct-message session', async () => {
    const f = fixture('D');
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
    expect((await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId }))?.sessionKey)
      .toBe(`agent:${f.target.agentId}:mattermost:direct:${'u'.repeat(26)}:thread:${threadRootPostId}`);
  });
  it('uses the authorized project agent and exact private-channel session', async () => {
    const f = fixture();
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toEqual({
      gatewayId, ownerUid: 'owner', channelId, expectedAgentId: f.target.agentId,
      sessionKey: `agent:${f.target.agentId}:mattermost:group:${channelId}`,
    });
    expect(f.authorize).toHaveBeenCalledWith(uid, channelId, undefined, { requireActiveLedger: true, includeDefaultAgentConversation: true });
  });
  it.each([['O', 'channel', channelId], ['P', 'group', channelId], ['D', 'direct', 'u'.repeat(26)]])('binds the selected existing %s thread to its native session', async (type, kind, peer) => {
    const f = fixture(type);
    expect(await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId })).toEqual({
      gatewayId, ownerUid: 'owner', channelId, expectedAgentId: f.target.agentId, threadRootPostId,
      sessionKey: `agent:${f.target.agentId}:mattermost:${kind}:${peer}${kind === 'direct' ? `:thread:${threadRootPostId}` : ''}`,
    });
    expect(f.client.getJson).toHaveBeenCalledWith(['posts', threadRootPostId]);
  });
  it.each([
    { id: threadRootPostId, channel_id: 'other', root_id: '', delete_at: 0 },
    { id: 'other', channel_id: channelId, root_id: '', delete_at: 0 },
    { id: threadRootPostId, channel_id: channelId, root_id: 'another-root', delete_at: 0 },
    { id: threadRootPostId, channel_id: channelId, root_id: '', delete_at: 1 },
  ])('refuses a selected post that is not a live root in the authorized channel: %j', async post => {
    const f = fixture();
    const getJson = f.client.getJson.getMockImplementation()!;
    f.client.getJson.mockImplementation(path => path[0] === 'posts' ? Promise.resolve(post) : getJson(path));
    expect(await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId })).toBeNull();
  });
  it('rejects a malformed thread target before authorizing or reading a channel', async () => {
    const f = fixture();
    expect(await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId: 'bad' })).toBeNull();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.client.getJson).not.toHaveBeenCalled();
  });
  it.each([403, 404])('denies an unavailable selected root (%s) without a room fallback', async status => {
    const f = fixture();
    const getJson = f.client.getJson.getMockImplementation()!;
    f.client.getJson.mockImplementation(path => path[0] === 'posts'
      ? Promise.reject(new ChannelSessionMattermostError('root unavailable', status))
      : getJson(path));
    expect(await resolveActivityConversation({ ...f, uid, channelId, threadRootPostId })).toBeNull();
  });
  it('surfaces a selected-root transport failure rather than falling back to room memory', async () => {
    const f = fixture();
    const getJson = f.client.getJson.getMockImplementation()!;
    const failure = new ChannelSessionMattermostError('transport unavailable', 503);
    f.client.getJson.mockImplementation(path => path[0] === 'posts' ? Promise.reject(failure) : getJson(path));
    await expect(resolveActivityConversation({ ...f, uid, channelId, threadRootPostId })).rejects.toBe(failure);
  });
  it('denies a removed channel member', async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce({ forbidden: true } as never);
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
  });
  it('denies an agent that is not the selected channel member', async () => {
    const f = fixture();
    f.client.getJson.mockResolvedValueOnce({ id: channelId, type: 'P', delete_at: 0 }).mockResolvedValueOnce({ channel_id: 'other', user_id: f.target.agentMmUserId });
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
  });
  it('refuses archived channels and absent owner assignments', async () => {
    const f = fixture();
    f.client.getJson.mockResolvedValueOnce({ id: channelId, type: 'P', delete_at: 1 });
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
    f.users.get.mockResolvedValueOnce({ uid: 'owner', slug: null, gateway: null, accountLifecycle: null } as unknown as PlatformUserRecord);
    expect(await resolveActivityConversation({ ...f, uid, channelId })).toBeNull();
  });
});
