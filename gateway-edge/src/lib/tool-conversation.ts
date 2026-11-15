import { trustedBrokerBaseUrl } from '@octogee/core/internal-brokers/automation-authorization-broker';
import { internalFetch } from '@octogee/core/internal-fetch';
import { WorkspaceNativeAccessError } from './workspace-native-access.js';
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';

export interface ToolConversation {
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  channelId: string;
  threadRootPostId: string;
  agentId: string;
  sessionKey: string;
  callerMmUserId: string;
}

export type ToolControl = Pick<ToolConversation, 'uid' | 'gatewayId' | 'workspaceSlug' | 'channelId' | 'callerMmUserId'>;
export type ToolChannel = Omit<ToolConversation, 'threadRootPostId'>;
function validChannelIdentity(body: Partial<ToolConversation>, args: { uid: string; gatewayId: string; channelId: string; expectedAgentId?: string }): boolean {
  return body.uid === args.uid && body.gatewayId === args.gatewayId && body.channelId === args.channelId &&
    typeof body.workspaceSlug === 'string' && /^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) &&
    body.agentId === `octogee-${body.workspaceSlug}-coach` &&
    (args.expectedAgentId === undefined || body.agentId === args.expectedAgentId) &&
    ['group', 'channel'].some(kind => body.sessionKey === `agent:${body.agentId}:mattermost:${kind}:${args.channelId}`);
}

export async function resolveToolConversationForUid(args: {
  uid: string; gatewayId: string; channelId: string; threadRootPostId: string; expectedAgentId?: string;
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}): Promise<ToolConversation> {
  const env = args.env ?? process.env;
  if (!isMattermostPostId(args.channelId) || !isMattermostPostId(args.threadRootPostId)) throw new WorkspaceNativeAccessError(403, 'Tool conversation unavailable');
  const rawBase = env.OPENCLAW_RUNTIME_BROKER_URL;
  if (!rawBase) throw new Error('OPENCLAW_RUNTIME_BROKER_URL is required');
  const base = trustedBrokerBaseUrl(rawBase, env);
  const response = await internalFetch(`${base}/internal/openclaw-control/tool-conversation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId, threadRootPostId: args.threadRootPostId, purpose: 'conversation' }),
  }, { fetchImpl: args.fetchImpl, requireProjectedToken: true, timeoutMs: 5000 });
  if (!response.ok) throw new WorkspaceNativeAccessError([401, 403, 404].includes(response.status) ? response.status : 503, 'Tool conversation unavailable');
  const body = await response.json() as Partial<ToolConversation>;
  if (!validChannelIdentity(body, args) || body.threadRootPostId !== args.threadRootPostId || !isMattermostPostId(body.callerMmUserId)) {
    throw new Error('Tool conversation broker returned an invalid context');
  }
  const { uid, gatewayId, workspaceSlug, channelId, threadRootPostId, agentId, sessionKey, callerMmUserId } = body as ToolConversation;
  return { uid, gatewayId, workspaceSlug, channelId, threadRootPostId, agentId, sessionKey, callerMmUserId };
}
export async function resolveToolChannelForUid(args: { uid: string; gatewayId: string; channelId: string; expectedAgentId?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<ToolChannel> {
  const env = args.env ?? process.env;
  if (!isMattermostPostId(args.channelId) || !env.OPENCLAW_RUNTIME_BROKER_URL) throw new WorkspaceNativeAccessError(403, 'Tool channel unavailable');
  const response = await internalFetch(`${trustedBrokerBaseUrl(env.OPENCLAW_RUNTIME_BROKER_URL, env)}/internal/openclaw-control/tool-conversation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
    body: JSON.stringify({ uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId, purpose: 'channel-tools' }),
  }, { fetchImpl: args.fetchImpl, requireProjectedToken: true, timeoutMs: 5000 });
  if (!response.ok) throw new WorkspaceNativeAccessError([401, 403, 404].includes(response.status) ? response.status : 503, 'Tool channel unavailable');
  const body = await response.json() as Partial<ToolConversation>;
  if (!validChannelIdentity(body, args) || body.threadRootPostId !== undefined || !isMattermostPostId(body.callerMmUserId)) throw new Error('Tool channel broker returned an invalid context');
  const { uid, gatewayId, workspaceSlug, channelId, agentId, sessionKey, callerMmUserId } = body as ToolChannel;
  return { uid, gatewayId, workspaceSlug, channelId, agentId, sessionKey, callerMmUserId };
}
export async function resolveToolControlForUid(args: { uid: string; gatewayId: string; channelId: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<ToolControl> {
  const env = args.env ?? process.env;
  if (!isMattermostPostId(args.channelId) || !env.OPENCLAW_RUNTIME_BROKER_URL) throw new WorkspaceNativeAccessError(403, 'Tool control unavailable');
  const response = await internalFetch(`${trustedBrokerBaseUrl(env.OPENCLAW_RUNTIME_BROKER_URL, env)}/internal/openclaw-control/tool-conversation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', body: JSON.stringify({ uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId, purpose: 'control' }),
  }, { fetchImpl: args.fetchImpl, requireProjectedToken: true, timeoutMs: 5000 });
  if (!response.ok) throw new WorkspaceNativeAccessError([401, 403, 404].includes(response.status) ? response.status : 503, 'Tool control unavailable');
  const body = await response.json() as Partial<ToolConversation>;
  if (body.uid !== args.uid || body.gatewayId !== args.gatewayId || body.channelId !== args.channelId || typeof body.workspaceSlug !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(body.workspaceSlug) || !isMattermostPostId(body.callerMmUserId) || body.sessionKey !== undefined || body.threadRootPostId !== undefined || body.agentId !== undefined) throw new Error('Tool control broker returned an invalid context');
  return { uid: args.uid, gatewayId: args.gatewayId, channelId: args.channelId, workspaceSlug: body.workspaceSlug, callerMmUserId: body.callerMmUserId };
}
