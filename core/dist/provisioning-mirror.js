import { workspaceDefaultAgentChannelName } from "@octogee/shared/types/identity";
import { MissingRecordError } from "./platform-state/errors.js";
import { AGENT_CHAT_SECRET_ID, ensureChatSecrets, USER_CHAT_SECRET_ID, } from "./provisioning-chat-secrets.js";
import { buildProvisioningContext, markProvisioningComplete, } from "./provisionSteps.js";
export class ProvisioningMirrorError extends Error {
    uid;
    constructor(uid, message) {
        super(message);
        this.uid = uid;
        this.name = "ProvisioningMirrorError";
    }
}
class ProvisioningMirrorRefusal extends Error {
    outcome;
    uid;
    constructor(outcome, uid) {
        super(`refusing to mirror ${uid}: ${outcome}`);
        this.outcome = outcome;
        this.uid = uid;
        this.name = "ProvisioningMirrorRefusal";
    }
}
const ERASURE_STATUSES = new Set(["deletion_scheduled", "erasing"]);
export function userBeingErased(user) {
    return user.accountLifecycle !== null && ERASURE_STATUSES.has(user.accountLifecycle.status);
}
function heldChatUser(row) {
    return row !== null && "mattermostUserId" in row && typeof row.mattermostUserId === "string" ? row.mattermostUserId : null;
}
export async function chatAccountMismatch(reader, user, chat) {
    const reported = `the provisioning service reports chat user ${chat.userId}`;
    if (user.mattermostUserId !== null && user.mattermostUserId !== chat.userId) {
        return `the user record holds chat user ${user.mattermostUserId}, ${reported}`;
    }
    const [userSecret, agentSecret, identity] = await Promise.all([
        reader.secrets.get(user.uid, USER_CHAT_SECRET_ID),
        reader.secrets.get(user.uid, AGENT_CHAT_SECRET_ID),
        reader.workspaces.agentIdentities.get(user.uid),
    ]);
    const userSecretHolder = heldChatUser(userSecret);
    if (userSecretHolder !== null && userSecretHolder !== chat.userId) {
        return `the ${USER_CHAT_SECRET_ID} platform secret belongs to chat user ${userSecretHolder}, ${reported}`;
    }
    const agent = chat.agentBotUserId;
    if (!agent)
        return null;
    const agentReported = `the provisioning service reports agent chat user ${agent}`;
    const agentSecretHolder = heldChatUser(agentSecret);
    if (agentSecretHolder !== null && agentSecretHolder !== agent) {
        return `the ${AGENT_CHAT_SECRET_ID} platform secret belongs to chat user ${agentSecretHolder}, ${agentReported}`;
    }
    const identityHolder = identity?.mattermostUserId ?? null;
    if (identityHolder !== null && identityHolder !== agent) {
        return `the agent identity holds chat user ${identityHolder}, ${agentReported}`;
    }
    return null;
}
function refusingStore(store, uid, chat) {
    const transaction = (options, body) => store.transaction(options, async (tx) => {
        const user = await tx.users.records.get(uid);
        if (user !== null && userBeingErased(user))
            throw new ProvisioningMirrorRefusal("being-erased", uid);
        if (user !== null && (await chatAccountMismatch(tx, user, chat)) !== null)
            throw new ProvisioningMirrorRefusal("chat-id-mismatch", uid);
        return body(tx);
    });
    return new Proxy(store, {
        get: (target, property, receiver) => property === "transaction" ? transaction : Reflect.get(target, property, receiver),
    });
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
    if (userBeingErased(user))
        return "being-erased";
    if ((await chatAccountMismatch(deps.store, user, chat)) !== null)
        return "chat-id-mismatch";
    try {
        return await mirrorAdmittedUser({ ...deps, store: refusingStore(deps.store, resource.uid, chat) }, resource, chat, slug);
    }
    catch (error) {
        if (error instanceof ProvisioningMirrorRefusal)
            return error.outcome;
        if (error instanceof MissingRecordError && error.record.aggregate === "builder" && error.record.key === resource.uid)
            return "user-missing";
        throw error;
    }
}
async function mirrorAdmittedUser(deps, resource, chat, slug) {
    const secrets = await ensureChatSecrets(deps, resource, chat);
    if (secrets !== "present")
        return secrets;
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
