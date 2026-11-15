import { parseChannelScopedMattermostSessionRoute, parseThreadedChannelMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";
export interface ChannelMembershipRpc {
    call<T>(method: string, params: Record<string, unknown>): Promise<{
        ok: true;
        result: T;
    } | {
        ok: false;
        reason: string;
    }>;
}
export interface AuthorizedNativeChannel {
    key: string;
    displayName?: unknown;
}
interface ChannelSyncDiagnostics {
    agentId: string;
    channelId: string;
    member: boolean;
    metadataAvailable: boolean;
    channelCreated?: boolean;
    creationSource?: "channel" | "talk" | "operator" | "missing" | "other";
    incognito?: boolean;
    draft?: boolean;
    matchingOrigin?: boolean;
}
export declare class ChannelMembershipSyncError extends Error {
    readonly diagnostics: ChannelSyncDiagnostics;
    constructor(diagnostics: ChannelSyncDiagnostics);
}
export declare function synchronizeChannelMembership(rpc: ChannelMembershipRpc, route: NonNullable<ReturnType<typeof parseChannelScopedMattermostSessionRoute>> | NonNullable<ReturnType<typeof parseThreadedChannelMattermostSessionRoute>>, profileId: string, member: boolean, displayName?: unknown): Promise<void>;
export declare function synchronizeChannelMemberships(input: {
    rpc: ChannelMembershipRpc;
    profileId: string;
    serviceProfileId: string;
    authorized: readonly AuthorizedNativeChannel[];
}): Promise<void>;
export {};
