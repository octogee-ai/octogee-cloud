import type { PlatformStateStore, PlatformUserRecord } from '../platform-state/index.js';
import { accountAllowsInteractiveAccess } from '@octogee/shared/types/account-lifecycle';
import { isValidGatewayId } from '@octogee/shared/types/glm';
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute } from '@octogee/shared/types/mattermost-session-route';
import { authorizeChannel, type AuthorizedChannel, type ChannelSessionMattermostClient } from './channel-session-authorization.js';
import { ChannelSessionMattermostError } from './channel-session-model-control.js';

export interface ActivityConversation {
  gatewayId: string;
  ownerUid: string;
  channelId: string;
  threadRootPostId?: string;
  expectedAgentId: string;
  sessionKey: string;
}

interface ActivityConversationInput {
  users: { get(uid: string): Promise<PlatformUserRecord | null> };
  uid: string;
  channelId: string;
  threadRootPostId?: string;
  authorize?: typeof authorizeChannel;
}

async function assignedGateway(input: ActivityConversationInput, { target }: AuthorizedChannel): Promise<string | null> {
  const [owner, caller] = await Promise.all([input.users.get(target.ownerUid), input.users.get(input.uid)]);
  if (!owner || !caller || !accountAllowsInteractiveAccess({ accountLifecycle: owner.accountLifecycle }) || !accountAllowsInteractiveAccess({ accountLifecycle: caller.accountLifecycle })) return null;
  const gatewayId = owner.gateway?.gatewayId;
  if (!isValidGatewayId(gatewayId) || !target.workspaceSlug || owner.slug !== target.workspaceSlug) return null;
  return gatewayId;
}

async function agentIsMember(client: ChannelSessionMattermostClient, channelId: string, agentMmUserId: string): Promise<boolean> {
  try {
    const member = await client.getJson(['channels', channelId, 'members', agentMmUserId]) as Record<string, unknown>;
    return Boolean(member && member.channel_id === channelId && member.user_id === agentMmUserId);
  } catch (error) {
    if (error instanceof ChannelSessionMattermostError && [403, 404].includes(error.status ?? 0)) return false;
    throw error;
  }
}

async function threadIsInChannel(client: ChannelSessionMattermostClient, channelId: string, threadRootPostId: string): Promise<boolean> {
  try {
    const post = await client.getJson(['posts', threadRootPostId]) as Record<string, unknown>;
    return Boolean(post && post.id === threadRootPostId && post.channel_id === channelId && post.root_id === '' && post.delete_at === 0);
  } catch (error) {
    if (error instanceof ChannelSessionMattermostError && [403, 404].includes(error.status ?? 0)) return false;
    throw error;
  }
}

const SESSION_KINDS: Record<string, 'direct' | 'group' | 'channel'> = { D: 'direct', P: 'group', O: 'channel' };

function isActiveChannel(channel: Record<string, unknown>, channelId: string): boolean {
  return Boolean(channel && channel.id === channelId && channel.delete_at === 0 && Object.keys(SESSION_KINDS).includes(String(channel.type)));
}

async function conversationChannel(
  client: ChannelSessionMattermostClient, channelId: string, agentMmUserId: string, threadRootPostId: string | undefined,
): Promise<Record<string, unknown> | null> {
  const channel = await client.getJson(['channels', channelId]) as Record<string, unknown>;
  if (!isActiveChannel(channel, channelId)) return null;
  if (!await agentIsMember(client, channelId, agentMmUserId)) return null;
  if (threadRootPostId !== undefined && !await threadIsInChannel(client, channelId, threadRootPostId)) return null;
  return channel;
}

async function resolveAuthorizedActivityConversation(input: ActivityConversationInput) {
  const { threadRootPostId } = input;
  if (threadRootPostId !== undefined && !isMattermostPostId(threadRootPostId)) return null;
  const access = await (input.authorize ?? authorizeChannel)(input.uid, input.channelId, undefined, {
    requireActiveLedger: true, includeDefaultAgentConversation: true,
  });
  if (!access || access.forbidden) return null;
  const { target } = access;
  const gatewayId = await assignedGateway(input, access);
  if (!gatewayId) return null;
  const channel = await conversationChannel(access.client, input.channelId, target.agentMmUserId, threadRootPostId);
  if (!channel) return null;
  const kind = SESSION_KINDS[String(channel.type)];
  const conversation = { gatewayId, ownerUid: target.ownerUid, channelId: input.channelId, expectedAgentId: target.agentId };
  if (kind === 'direct') {
    return threadRootPostId === undefined
      ? null
      : { access, scope: { ...conversation, threadRootPostId, sessionKey: `agent:${target.agentId}:mattermost:direct:${access.callerMmUserId}:thread:${threadRootPostId}` } };
  }
  return {
    access,
    scope: {
      ...conversation,
      ...(threadRootPostId === undefined ? {} : { threadRootPostId }),
      sessionKey: `agent:${target.agentId}:mattermost:${kind}:${input.channelId}`,
    },
  };
}

export async function resolveActivityConversation(input: ActivityConversationInput): Promise<ActivityConversation | null> {
  return (await resolveAuthorizedActivityConversation(input))?.scope ?? null;
}

export async function resolveChannelRunControlConversation(
  input: ActivityConversationInput,
  workspaces: PlatformStateStore['workspaces'],
) {
  const result = await resolveAuthorizedActivityConversation(input);
  if (!result || !parseChannelScopedMattermostSessionRoute(result.scope.sessionKey)) return null;
  const { access, scope } = result;
  const { ownerUid, workspaceSlug, projectId } = access.target;
  const channel = await workspaces.channels.findByMattermostChannelId(scope.channelId);
  if (!channel || channel.archivedAt !== null || channel.scope.workspaceSlug !== workspaceSlug
    || channel.scope.projectSlug !== (projectId ?? null)) return null;
  const member = projectId
    ? await workspaces.projectMembers.get(workspaceSlug, projectId, input.uid)
    : await workspaces.members.get(workspaceSlug, input.uid);
  return {
    ...scope,
    callerMmUserId: access.callerMmUserId,
    isOwner: ownerUid === input.uid || channel.createdBy === input.uid || member?.role === 'owner',
  };
}
