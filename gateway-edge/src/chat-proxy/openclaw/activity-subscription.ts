import { WebSocket } from 'ws';
import type { ActivityConversation } from '@octogee/core/channels/activity-conversation';
import { attachUpstreamRpcClient } from '@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc';
import type { OpenClawRuntimeBroker } from './runtime-broker.js';

export function attachActivitySubscription(input: {
  upstream: WebSocket;
  client: WebSocket;
  scope: ActivityConversation;
  uid: string;
  broker: Pick<OpenClawRuntimeBroker, 'getActivityConversation'>;
  warn(message: string, metadata: Record<string, unknown>): void;
}): () => void {
  const { upstream, client, scope, uid, broker, warn } = input;
  const rpc = attachUpstreamRpcClient(upstream);
  let disposed = false;
  let checking = false;
  const close = (code: number, reason: string) => {
    if (!disposed && client.readyState === WebSocket.OPEN) client.close(code, reason);
  };
  const timer = setInterval(() => {
    if (checking || disposed) return;
    checking = true;
    void (async () => {
      if (!broker.getActivityConversation) throw new Error('Activity authorization unavailable');
      const current = await broker.getActivityConversation(uid, scope.channelId, scope.threadRootPostId);
      if (!current || Object.keys(scope).some(key => current[key as keyof ActivityConversation] !== scope[key as keyof ActivityConversation])) close(1008, 'activity-access-changed');
    })().catch(error => {
      warn('[activity] access check failed', { gatewayId: scope.gatewayId, error: error instanceof Error ? error.message : String(error) });
      close(1013, 'activity-access-unavailable');
    }).finally(() => { checking = false; });
  }, 30_000);
  timer.unref();
  void (async () => {
    if (!broker.getActivityConversation) throw new Error('Activity authorization unavailable');
    const current = await broker.getActivityConversation(uid, scope.channelId, scope.threadRootPostId);
    if (!current || Object.keys(scope).some(key => current[key as keyof ActivityConversation] !== scope[key as keyof ActivityConversation])) {
      close(1008, 'activity-access-changed'); return;
    }
    for (const [method, params] of [
      ['sessions.messages.subscribe', { key: scope.sessionKey, agentId: scope.expectedAgentId }],
      ['sessions.subscribe', {}],
    ] as const) {
      if (disposed) return;
      const result = await rpc.call(method, params);
      if (!result.ok) throw new Error(`${method}: ${result.reason}`);
    }
    if (!disposed && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'event', event: 'activity.ready', payload: { sessionKey: scope.sessionKey } }));
  })().catch(error => {
    warn('[activity] native subscription failed', { gatewayId: scope.gatewayId, channelId: scope.channelId, error: error instanceof Error ? error.message : String(error) });
    close(1013, 'activity-subscription-unavailable');
  });
  return () => {
    disposed = true;
    clearInterval(timer);
    rpc.dispose();
  };
}
