import { parseChannelScopedMattermostSessionRoute, parseThreadedChannelMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";
async function request(rpc, method, params) {
    const response = await rpc.call(method, params);
    if (!response.ok)
        throw new Error(`${method} failed: ${response.reason}`);
    return response.result;
}
export class ChannelMembershipSyncError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super("Native channel membership synchronization failed");
        this.diagnostics = diagnostics;
        this.name = "ChannelMembershipSyncError";
    }
}
function channelCreationSource(via) {
    if (via === "channel" || via === "talk" || via === "operator")
        return via;
    return via === undefined ? "missing" : "other";
}
export async function synchronizeChannelMembership(rpc, route, profileId, member, displayName) {
    const threadSuffix = 'threadRootPostId' in route ? `:thread:${route.threadRootPostId}` : '';
    const sessionKey = `agent:${route.agentId}:mattermost:${route.peerKind}:${route.primaryChannelId}${threadSuffix}`;
    const result = await rpc.call("sessions.channel.sync", {
        agentId: route.agentId, channel: "mattermost", peerKind: route.peerKind,
        peerId: route.primaryChannelId, profileId, member,
        ...('threadRootPostId' in route ? { threadRootPostId: route.threadRootPostId } : {}),
        ...(typeof displayName === "string" ? { displayName } : {}),
    });
    if (result.ok)
        return;
    const diagnostics = {
        agentId: route.agentId, channelId: route.primaryChannelId, member, metadataAvailable: false,
    };
    try {
        const metadata = await rpc.call("sessions.describe", {
            key: sessionKey,
            agentId: route.agentId, includeDerivedTitles: false, includeLastMessage: false,
        });
        const session = metadata.ok ? metadata.result?.session : null;
        if (session?.key === sessionKey) {
            diagnostics.metadataAvailable = true;
            diagnostics.channelCreated = session.createdVia === "channel";
            diagnostics.creationSource = channelCreationSource(session.createdVia);
            diagnostics.incognito = session.incognito === true;
            diagnostics.draft = session.visibility === "draft";
            if (session.origin)
                diagnostics.matchingOrigin = session.origin.provider === "mattermost" &&
                    session.origin.chatType === route.peerKind && session.origin.nativeChannelId === route.primaryChannelId;
        }
    }
    catch {
        diagnostics.metadataAvailable = false;
    }
    throw new ChannelMembershipSyncError(diagnostics);
}
export async function synchronizeChannelMemberships(input) {
    const { rpc, profileId, serviceProfileId } = input;
    const desired = new Map(input.authorized.map((row) => [row.key, row]));
    if (desired.size !== input.authorized.length)
        throw new Error("Duplicate authorized channel identity");
    for (const key of desired.keys()) {
        if (!parseChannelScopedMattermostSessionRoute(key))
            throw new Error("Invalid authorized channel identity");
    }
    const native = await request(rpc, "sessions.list", {
        archived: "all", limit: 10_000, includeUnknown: true,
    });
    if (!Array.isArray(native.sessions) || native.hasMore === true) {
        throw new Error("Native channel membership directory is incomplete");
    }
    const removals = [];
    for (const row of native.sessions) {
        const route = parseChannelScopedMattermostSessionRoute(row.key) ?? parseThreadedChannelMattermostSessionRoute(row.key);
        if (!route)
            continue;
        const channelKey = `agent:${route.agentId}:mattermost:${route.peerKind}:${route.primaryChannelId}`;
        if (desired.has(channelKey))
            continue;
        const evidence = await request(rpc, "session.members.listEvidence", { sessionKey: row.key, agentId: route.agentId });
        if (!Array.isArray(evidence.members))
            throw new Error("Invalid native channel membership evidence");
        if (evidence.members.some((member) => member.identityId === profileId && member.addedBy === serviceProfileId)) {
            removals.push(route);
        }
    }
    for (const route of removals) {
        if (!route)
            continue;
        await synchronizeChannelMembership(rpc, route, profileId, false);
    }
    for (const row of desired.values()) {
        const route = parseChannelScopedMattermostSessionRoute(row.key);
        await synchronizeChannelMembership(rpc, route, profileId, true, row.displayName);
    }
}
