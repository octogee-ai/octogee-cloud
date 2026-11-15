import { createChannelSessionMattermostClient } from "./channel-session-model-control.js";
export interface ChannelTarget {
    ownerUid: string;
    workspaceSlug: string;
    projectId?: string;
    agentId: string;
    agentMmUserId: string;
}
export type ChannelSessionMattermostClient = ReturnType<typeof createChannelSessionMattermostClient>;
export interface AuthorizedChannel {
    forbidden: false;
    target: ChannelTarget;
    client: ChannelSessionMattermostClient;
    callerMmUserId: string;
}
export interface ForbiddenChannel {
    forbidden: true;
}
export interface WorkspaceChannelCandidate {
    channelId: string;
}
export interface ChannelAuthorizationOptions {
    requireActiveLedger?: boolean;
    includeDefaultAgentConversation?: boolean;
    workspaceConversation?: boolean;
    voiceConversation?: boolean;
    signal?: AbortSignal;
}
export declare function listWorkspaceChannelCandidates(workspaceSlug: string, signal?: AbortSignal): Promise<WorkspaceChannelCandidate[]>;
export declare function authorizeChannelCredentials(uid: string, channelId: string, expectedWorkspaceSlug?: string, options?: ChannelAuthorizationOptions): Promise<AuthorizedChannelCredentials | ForbiddenChannel | null>;
export interface AuthorizedChannelCredentials extends Omit<AuthorizedChannel, "client"> {
    token: string;
}
export declare function authorizeChannel(uid: string, channelId: string, expectedWorkspaceSlug?: string, options?: ChannelAuthorizationOptions): Promise<AuthorizedChannel | ForbiddenChannel | null>;
