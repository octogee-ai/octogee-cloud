import { accountAllowsInteractiveAccess } from '@octogee/shared/types/account-lifecycle';
import { isValidGatewayId } from '@octogee/shared/types/glm';
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { authorizeChannel } from './channel-session-authorization.js';
import { ChannelSessionMattermostError } from './channel-session-model-control.js';
async function assignedGateway(input, { target }) {
    const [owner, caller] = await Promise.all([input.users.get(target.ownerUid), input.users.get(input.uid)]);
    if (!owner || !caller || !accountAllowsInteractiveAccess({ accountLifecycle: owner.accountLifecycle }) || !accountAllowsInteractiveAccess({ accountLifecycle: caller.accountLifecycle }))
        return null;
    const gatewayId = owner.gateway?.gatewayId;
    if (!isValidGatewayId(gatewayId) || !target.workspaceSlug || owner.slug !== target.workspaceSlug)
        return null;
    return gatewayId;
}
async function agentIsMember(client, channelId, agentMmUserId) {
    try {
        const member = await client.getJson(['channels', channelId, 'members', agentMmUserId]);
        return Boolean(member && member.channel_id === channelId && member.user_id === agentMmUserId);
    }
    catch (error) {
        if (error instanceof ChannelSessionMattermostError && [403, 404].includes(error.status ?? 0))
            return false;
        throw error;
    }
}
async function threadIsInChannel(client, channelId, threadRootPostId) {
    try {
        const post = await client.getJson(['posts', threadRootPostId]);
        return Boolean(post && post.id === threadRootPostId && post.channel_id === channelId && post.root_id === '' && post.delete_at === 0);
    }
    catch (error) {
        if (error instanceof ChannelSessionMattermostError && [403, 404].includes(error.status ?? 0))
            return false;
        throw error;
    }
}
const SESSION_KINDS = { D: 'direct', P: 'group', O: 'channel' };
function isActiveChannel(channel, channelId) {
    return Boolean(channel && channel.id === channelId && channel.delete_at === 0 && Object.keys(SESSION_KINDS).includes(String(channel.type)));
}
async function conversationChannel(client, channelId, agentMmUserId, threadRootPostId) {
    const channel = await client.getJson(['channels', channelId]);
    if (!isActiveChannel(channel, channelId))
        return null;
    if (!await agentIsMember(client, channelId, agentMmUserId))
        return null;
    if (threadRootPostId !== undefined && !await threadIsInChannel(client, channelId, threadRootPostId))
        return null;
    return channel;
}
export async function resolveActivityConversation(input) {
    const { threadRootPostId } = input;
    if (threadRootPostId !== undefined && !isMattermostPostId(threadRootPostId))
        return null;
    const access = await (input.authorize ?? authorizeChannel)(input.uid, input.channelId, undefined, {
        requireActiveLedger: true, includeDefaultAgentConversation: true,
    });
    if (!access || access.forbidden)
        return null;
    const { target } = access;
    const gatewayId = await assignedGateway(input, access);
    if (!gatewayId)
        return null;
    const channel = await conversationChannel(access.client, input.channelId, target.agentMmUserId, threadRootPostId);
    if (!channel)
        return null;
    const kind = SESSION_KINDS[String(channel.type)];
    const conversation = { gatewayId, ownerUid: target.ownerUid, channelId: input.channelId, expectedAgentId: target.agentId };
    if (kind === 'direct') {
        return threadRootPostId === undefined
            ? null
            : { ...conversation, threadRootPostId, sessionKey: `agent:${target.agentId}:mattermost:direct:${access.callerMmUserId}:thread:${threadRootPostId}` };
    }
    return {
        ...conversation,
        ...(threadRootPostId === undefined ? {} : { threadRootPostId }),
        sessionKey: `agent:${target.agentId}:mattermost:${kind}:${input.channelId}`,
    };
}
