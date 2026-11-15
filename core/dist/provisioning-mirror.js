import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import { ensureChatSecrets } from "./provisioning-chat-secrets.js";
import { buildProvisioningContext, markProvisioningComplete, } from "./provisionSteps.js";
export class ProvisioningMirrorError extends Error {
    uid;
    constructor(uid, message) {
        super(message);
        this.uid = uid;
        this.name = "ProvisioningMirrorError";
    }
}
function chatReady(resource) {
    const condition = resource.status.conditions.find((candidate) => candidate.type === "ChatReady");
    const chat = resource.status.outputs.chat;
    if (condition?.status !== "True" || chat === undefined)
        return null;
    return chat.userId && chat.teamId && chat.channels.general ? chat : null;
}
export function mmUpdateFromChatOutputs(input) {
    const { slug, chat, agentChannelName, proxyUrl } = input;
    const agentChannel = chat.channels.agent;
    return {
        "mattermost.userId": chat.userId,
        "mattermost.username": slug,
        "mattermost.teamId": chat.teamId,
        "mattermost.generalChannelId": chat.channels.general,
        ...(agentChannel
            ? {
                "mattermost.channelId": agentChannel,
                "mattermost.dmChannelId": agentChannel,
                "mattermost.channelName": agentChannelName,
            }
            : {}),
        ...(proxyUrl === null ? {} : { "mattermost.proxyUrl": proxyUrl }),
        ...(chat.agentBotUserId ? { "mattermost.coachUserId": chat.agentBotUserId } : {}),
    };
}
async function userRecordsMatch(store, resource, chat, slug) {
    const [user, workspace, owner] = await Promise.all([
        store.users.records.get(resource.uid),
        store.workspaces.records.get(slug),
        store.workspaces.members.get(slug, resource.uid),
    ]);
    if (user === null || workspace === null || owner === null)
        return false;
    const agentIds = new Set(user.agents.agentIds);
    return (user.mattermostUserId === chat.userId &&
        user.workspaceId === slug &&
        user.openclaw.provisionedAt !== undefined &&
        resource.spec.agentIds.every((agentId) => agentIds.has(agentId)) &&
        workspace.ownerUid === resource.uid &&
        workspace.mattermostTeamId === chat.teamId);
}
async function chatRecordsMatch(store, uid, chat, slug) {
    const scope = { workspaceSlug: slug, projectSlug: null };
    const agentChannelId = chat.channels.agent;
    const agentBotUserId = chat.agentBotUserId;
    const [general, agentChannel, identity] = await Promise.all([
        store.workspaces.channels.get(scope, "general"),
        agentChannelId ? store.workspaces.channels.get(scope, "coach-dm") : null,
        agentBotUserId ? store.workspaces.agentIdentities.get(uid) : null,
    ]);
    return (general?.mattermostChannelId === chat.channels.general &&
        (!agentChannelId || agentChannel?.mattermostChannelId === agentChannelId) &&
        (!agentBotUserId || identity?.mattermostUserId === agentBotUserId));
}
async function recordsMatch(store, resource, chat, slug) {
    return (await userRecordsMatch(store, resource, chat, slug)) && (await chatRecordsMatch(store, resource.uid, chat, slug));
}
export async function mirrorUserProvisioning(deps, resource) {
    const chat = chatReady(resource);
    if (chat === null)
        return "chat-not-ready";
    const user = await deps.store.users.records.get(resource.uid);
    if (user === null)
        return "user-missing";
    const slug = resource.spec.slug;
    if (user.slug !== slug)
        return "slug-mismatch";
    if ((await ensureChatSecrets(deps, resource, chat)) === "credentials-not-issued")
        return "credentials-not-issued";
    if (await recordsMatch(deps.store, resource, chat, slug))
        return "unchanged";
    const userData = await deps.documents.account(resource.uid);
    if (userData === undefined) {
        throw new ProvisioningMirrorError(resource.uid, `user ${resource.uid} has no account document to mirror provisioning from`);
    }
    const ctx = buildProvisioningContext(resource.uid, userData);
    const stored = await deps.projection.storedMattermostNames(resource.uid, slug);
    const mmUpdate = mmUpdateFromChatOutputs({
        slug,
        chat,
        agentChannelName: stored.coachChannelName ?? workspaceDefaultAgentChannelName(slug),
        proxyUrl: deps.proxyUrl,
    });
    await markProvisioningComplete(ctx, mmUpdate, [...resource.spec.agentIds], deps.projection, deps.store);
    return "written";
}
