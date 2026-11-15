import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachActivitySubscription } from '../activity-subscription.js';
const rpc = vi.hoisted(() => ({ call: vi.fn(), dispose: vi.fn() }));
vi.mock('@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc', () => ({ attachUpstreamRpcClient: () => rpc }));
const threadRootPostId = 'r'.repeat(26);
const scope = { gatewayId: 'shared-123456789abc', ownerUid: 'owner', channelId: 'c'.repeat(26), threadRootPostId, expectedAgentId: 'octogee-alice-coach', sessionKey: `agent:octogee-alice-coach:mattermost:group:${'c'.repeat(26)}` };
function setup(activityScope: typeof scope | Omit<typeof scope, 'threadRootPostId'> = scope) {
  vi.useFakeTimers();
  rpc.call.mockReset().mockResolvedValue({ ok: true, result: { subscribed: true } });
  rpc.dispose.mockClear();
  const client = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const broker = { getActivityConversation: vi.fn(async () => activityScope) };
  const warn = vi.fn();
  const stop = attachActivitySubscription({ upstream: {} as never, client: client as never, uid: 'member', scope: activityScope, broker, warn });
  return { client, broker, warn, stop };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('native Activity subscriptions', () => {
  it('subscribes only to the selected session and never requests a session-list snapshot', async () => {
    const h = setup(); await vi.advanceTimersByTimeAsync(0);
    expect(rpc.call.mock.calls).toEqual([
      ['sessions.messages.subscribe', { key: scope.sessionKey, agentId: scope.expectedAgentId }], ['sessions.subscribe', {}],
    ]);
    expect(JSON.parse(h.client.send.mock.calls[0][0])).toEqual({ type: 'event', event: 'activity.ready', payload: { sessionKey: scope.sessionKey } });
    h.stop(); expect(rpc.dispose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(h.broker.getActivityConversation).toHaveBeenCalledExactlyOnceWith('member', scope.channelId, threadRootPostId);
  });
  it('subscribes and rechecks a channel-scoped conversation without a selected thread', async () => {
    const { threadRootPostId: _thread, ...channelScope } = scope;
    const h = setup(channelScope); await vi.advanceTimersByTimeAsync(0);
    expect(rpc.call.mock.calls[0]).toEqual(['sessions.messages.subscribe', { key: scope.sessionKey, agentId: scope.expectedAgentId }]);
    expect(JSON.parse(h.client.send.mock.calls[0][0])).toEqual({ type: 'event', event: 'activity.ready', payload: { sessionKey: scope.sessionKey } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.broker.getActivityConversation).toHaveBeenCalledTimes(2);
    expect(h.broker.getActivityConversation).toHaveBeenLastCalledWith('member', scope.channelId, undefined);
    expect(h.client.close).not.toHaveBeenCalled(); h.stop();
  });
  it('closes after membership revocation or a changed native scope', async () => {
    const h = setup(); h.broker.getActivityConversation.mockResolvedValueOnce(null as never);
    await vi.advanceTimersByTimeAsync(30_000); expect(h.client.close).toHaveBeenCalledWith(1008, 'activity-access-changed'); h.stop();
  });
  it('fails closed when authorization is unavailable', async () => {
    const h = setup(); h.broker.getActivityConversation.mockRejectedValueOnce(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(30_000); expect(h.client.close).toHaveBeenCalledWith(1013, 'activity-access-unavailable'); expect(h.warn).toHaveBeenCalled(); h.stop();
  });
  it('never marks a refused native subscription ready', async () => {
    const h = setup(); rpc.call.mockResolvedValue({ ok: false, reason: 'denied' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.send).not.toHaveBeenCalled(); expect(h.client.close).toHaveBeenCalledWith(1013, 'activity-subscription-unavailable'); h.stop();
  });
});
