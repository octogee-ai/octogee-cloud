import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
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
async function recordsMatch(store, resource, chat, slug) {
    const scope = { workspaceSlug: slug, projectSlug: null };
    const [user, workspace, general, agentChannel, owner, identity] = await Promise.all([
        store.users.records.get(resource.uid),
        store.workspaces.records.get(slug),
        store.workspaces.channels.get(scope, "general"),
        chat.channels.agent ? store.workspaces.channels.get(scope, "coach-dm") : Promise.resolve(null),
        store.workspaces.members.get(slug, resource.uid),
        chat.agentBotUserId ? store.workspaces.agentIdentities.get(resource.uid) : Promise.resolve(null),
    ]);
    if (user === null || workspace === null || owner === null)
        return false;
    const agentIds = new Set(user.agents.agentIds);
    return (user.mattermostUserId === chat.userId &&
        user.workspaceId === slug &&
        user.openclaw.provisionedAt !== undefined &&
        resource.spec.agentIds.every((agentId) => agentIds.has(agentId)) &&
        workspace.ownerUid === resource.uid &&
        workspace.mattermostTeamId === chat.teamId &&
        general?.mattermostChannelId === chat.channels.general &&
        (!chat.channels.agent || agentChannel?.mattermostChannelId === chat.channels.agent) &&
        (!chat.agentBotUserId || identity?.mattermostUserId === chat.agentBotUserId));
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
