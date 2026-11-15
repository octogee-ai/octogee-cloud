import { projectAgentId, USERNAME_RE, workspaceDefaultAgentId, } from "@octogee/shared/types/identity";
import { projectAgentConfigured } from "@octogee/shared/types/project";
import { DuplicateRecordError, } from "../platform-state/index.js";
import { projectAgentSecretDocId } from "../mattermost/project-agent.js";
import { ChannelSessionMattermostError, createChannelSessionMattermostClient, } from "./channel-session-model-control.js";
import { readMattermostSecret } from "../identity/mattermost-secret.js";
import { platformStateStore } from "../identity/platform-state-store.js";
import { resolveWorkspaceUid } from "../workspace/workspace-resolution.js";
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const MAX_WORKSPACE_CHANNEL_CANDIDATES = 512;
const PROJECT_CHANNEL_DISCOVERY_CONCURRENCY = 8;
async function abortable(promise, signal) {
    if (!signal)
        return promise;
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        promise.then((value) => {
            signal.removeEventListener("abort", aborted);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", aborted);
            reject(error);
        });
    });
}
function discoverableChannelId(channel) {
    if (channel.archivedAt !== null)
        return null;
    const id = channel.channelId;
    if (channel.scope.projectSlug === null && (id === "admin" || id === "coach-dm"))
        return null;
    const expectedKind = id === "general" ? "general" : "session";
    if (channel.kind !== expectedKind) {
        throw new ChannelSessionMattermostError("Workspace channel ledger was invalid");
    }
    const channelId = channel.mattermostChannelId;
    if (channelId === null || !MATTERMOST_ID.test(channelId)) {
        throw new ChannelSessionMattermostError("Workspace channel ledger was invalid");
    }
    return channelId;
}
export async function listWorkspaceChannelCandidates(workspaceSlug, signal) {
    if (!USERNAME_RE.test(workspaceSlug)) {
        throw new ChannelSessionMattermostError("Workspace channel scope was invalid");
    }
    const [workspaceChannels, projects] = await abortable(Promise.all([
        platformStateStore.workspaces.channels.list({ workspaceSlug, projectSlug: null }),
        platformStateStore.workspaces.projects.list(workspaceSlug),
    ]), signal);
    if (workspaceChannels.length > MAX_WORKSPACE_CHANNEL_CANDIDATES ||
        projects.length > MAX_WORKSPACE_CHANNEL_CANDIDATES) {
        throw new ChannelSessionMattermostError("Workspace channel directory exceeded its limit");
    }
    const activeProjects = projects.filter((project) => project.commercialLifecycleStatus !== "archived");
    const channelIds = [];
    for (const channel of workspaceChannels) {
        const channelId = discoverableChannelId(channel);
        if (channelId)
            channelIds.push(channelId);
    }
    for (let offset = 0; offset < activeProjects.length; offset += PROJECT_CHANNEL_DISCOVERY_CONCURRENCY) {
        signal?.throwIfAborted();
        const reads = activeProjects
            .slice(offset, offset + PROJECT_CHANNEL_DISCOVERY_CONCURRENCY)
            .map((project) => platformStateStore.workspaces.channels.list({
            workspaceSlug,
            projectSlug: project.projectSlug,
        }));
        for (const channels of await abortable(Promise.all(reads), signal)) {
            if (channelIds.length + channels.length > MAX_WORKSPACE_CHANNEL_CANDIDATES) {
                throw new ChannelSessionMattermostError("Workspace channel directory exceeded its limit");
            }
            for (const channel of channels) {
                const channelId = discoverableChannelId(channel);
                if (channelId)
                    channelIds.push(channelId);
            }
        }
    }
    if (new Set(channelIds).size !== channelIds.length) {
        throw new ChannelSessionMattermostError("Workspace channel directory was ambiguous");
    }
    return channelIds.sort().map((channelId) => ({ channelId }));
}
function channelScope(channel) {
    return channel.scope.projectSlug === null
        ? { workspaceSlug: channel.scope.workspaceSlug }
        : { workspaceSlug: channel.scope.workspaceSlug, projectId: channel.scope.projectSlug };
}
function activeMattermostUserId(credential) {
    const mmUserId = credential?.mattermostUserId;
    if (!mmUserId || !MATTERMOST_ID.test(mmUserId) || !credential.personalToken)
        return null;
    return mmUserId;
}
async function resolveProjectTarget(scope, ownerUid, requireActiveLedger, signal) {
    if (!scope.projectId)
        return { archived: false, target: null };
    const [project, secret] = await abortable(Promise.all([
        platformStateStore.workspaces.projects.get(scope.workspaceSlug, scope.projectId),
        readMattermostSecret(platformStateStore, ownerUid, projectAgentSecretDocId(scope.projectId)),
    ]), signal);
    if (requireActiveLedger && project?.commercialLifecycleStatus === "archived") {
        return { archived: true, target: null };
    }
    const agentMmUserId = projectAgentConfigured(project?.agent) ? activeMattermostUserId(secret) : null;
    if (!agentMmUserId)
        return { archived: false, target: null };
    return {
        archived: false,
        target: {
            ...scope,
            ownerUid,
            agentId: projectAgentId(scope.workspaceSlug, scope.projectId),
            agentMmUserId,
        },
    };
}
async function resolveDefaultAgentTarget(scope, ownerUid, signal) {
    const defaultAgentSecret = await abortable(readMattermostSecret(platformStateStore, ownerUid, "coachMattermost"), signal);
    const agentMmUserId = defaultAgentSecret?.mattermostUserId;
    if (!agentMmUserId || !MATTERMOST_ID.test(agentMmUserId)) {
        return null;
    }
    return {
        ...scope,
        ownerUid,
        agentId: workspaceDefaultAgentId(scope.workspaceSlug),
        agentMmUserId,
    };
}
function workspaceConversationLedger(channel, channelId) {
    if (channel.scope.projectSlug !== null || channel.channelId === "admin")
        return false;
    if (channel.archivedAt !== null)
        return false;
    const expectedKind = channel.channelId === "general" || channel.channelId === "coach-dm" ? channel.channelId : "session";
    return channel.kind === expectedKind && channel.mattermostChannelId === channelId;
}
function activeChannelLedger(channel, channelId, options) {
    if (options.includeDefaultAgentConversation && channel.channelId === "coach-dm" && channel.scope.projectSlug === null) {
        return workspaceConversationLedger(channel, channelId);
    }
    return discoverableChannelId(channel) === channelId;
}
function conversationLedgerAllowed(channel, channelId, options) {
    if (options.workspaceConversation && !workspaceConversationLedger(channel, channelId))
        return false;
    if (!options.voiceConversation)
        return true;
    if (channel.channelId === 'admin')
        return false;
    return channel.scope.projectSlug !== null ? activeChannelLedger(channel, channelId, options) : workspaceConversationLedger(channel, channelId);
}
async function boundChannelLedger(channelId) {
    try {
        return await platformStateStore.workspaces.channels.findByMattermostChannelId(channelId);
    }
    catch (error) {
        if (error instanceof DuplicateRecordError)
            return null;
        throw error;
    }
}
async function resolveTarget(channelId, expectedWorkspaceSlug, options) {
    const channel = await abortable(boundChannelLedger(channelId), options.signal);
    if (!channel)
        return null;
    const scope = channelScope(channel);
    if (!conversationLedgerAllowed(channel, channelId, options))
        return null;
    if (expectedWorkspaceSlug !== undefined &&
        scope.workspaceSlug !== expectedWorkspaceSlug) {
        return null;
    }
    if (options.requireActiveLedger &&
        !activeChannelLedger(channel, channelId, options)) {
        return null;
    }
    const ownerUid = await abortable(resolveWorkspaceUid(scope.workspaceSlug), options.signal);
    if (!ownerUid)
        return null;
    if (scope.projectId) {
        const project = await resolveProjectTarget(scope, ownerUid, options.requireActiveLedger === true || options.voiceConversation === true, options.signal);
        if (project.archived)
            return null;
        if (options.voiceConversation)
            return project.target;
        return project.target ?? resolveDefaultAgentTarget(scope, ownerUid, options.signal);
    }
    return resolveDefaultAgentTarget(scope, ownerUid, options.signal);
}
async function callerCredentials(uid, signal) {
    const [user, secret] = await abortable(Promise.all([
        platformStateStore.users.records.get(uid),
        readMattermostSecret(platformStateStore, uid, "mattermost"),
    ]), signal);
    const storedUserId = user?.mattermostUserId;
    return storedUserId && MATTERMOST_ID.test(storedUserId) && secret
        ? { storedUserId, token: secret.personalToken }
        : null;
}
export async function authorizeChannelCredentials(uid, channelId, expectedWorkspaceSlug, options = {}) {
    const [target, credentials] = await abortable(Promise.all([
        resolveTarget(channelId, expectedWorkspaceSlug, options),
        callerCredentials(uid, options.signal),
    ]), options.signal);
    if (!target ||
        !credentials ||
        (expectedWorkspaceSlug !== undefined &&
            target.workspaceSlug !== expectedWorkspaceSlug)) {
        return null;
    }
    const client = createChannelSessionMattermostClient({
        baseUrl: process.env.MM_INTERNAL_URL ?? "",
        token: credentials.token,
        signal: options.signal,
    });
    const liveUserId = await client.getCurrentUserId();
    if (liveUserId !== credentials.storedUserId) {
        return { forbidden: true };
    }
    try {
        await client.getJson(["channels", channelId, "members", liveUserId]);
    }
    catch (error) {
        if (error instanceof ChannelSessionMattermostError &&
            (error.status === 403 || error.status === 404)) {
            return { forbidden: true };
        }
        throw error;
    }
    return {
        forbidden: false,
        target,
        token: credentials.token,
        callerMmUserId: liveUserId,
    };
}
export async function authorizeChannel(uid, channelId, expectedWorkspaceSlug, options = {}) {
    const access = await authorizeChannelCredentials(uid, channelId, expectedWorkspaceSlug, options);
    if (!access || access.forbidden)
        return access;
    return {
        forbidden: false,
        target: access.target,
        callerMmUserId: access.callerMmUserId,
        client: createChannelSessionMattermostClient({
            baseUrl: process.env.MM_INTERNAL_URL ?? "",
            token: access.token,
            signal: options.signal,
        }),
    };
}
