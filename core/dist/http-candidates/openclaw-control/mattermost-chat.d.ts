import { type authorizeChannel, type listWorkspaceChannelCandidates } from "../../channels/channel-session-authorization.js";
import { type MattermostModelPost } from "../../channels/channel-session-model-control.js";
import type { OpenClawControlProxyIdentity } from "./proxy-identity.js";
import type { OpenClawControlSession } from "./session.js";
export interface OpenClawControlRequestFrame extends Record<string, unknown> {
    type?: unknown;
    id: string;
    method: string;
    params: Record<string, unknown>;
}
export interface MattermostChannelWatch {
    sessionKey: string;
    agentId: string;
    run(onChange: () => void, signal: AbortSignal): Promise<void>;
}
export type MattermostChatPreparation = {
    kind: "response";
    frame: Record<string, unknown>;
    watch?: MattermostChannelWatch;
} | {
    kind: "upstream";
    upstreamParams?: Record<string, unknown>;
    project(frame: Record<string, unknown>): Record<string, unknown>;
    watch?: MattermostChannelWatch;
};
export interface MattermostControlChat {
    prepare(frame: OpenClawControlRequestFrame, session: OpenClawControlSession, signal?: AbortSignal): Promise<MattermostChatPreparation | null>;
}
interface ProjectedMessage {
    role: "user" | "assistant";
    content: Array<{
        type: "text";
        text: string;
    }>;
    timestamp: number;
    __openclaw: {
        id: string;
        seq: number;
        runId: string;
        idempotencyKey?: string;
        senderId?: string;
        senderName?: string;
        senderUsername?: string;
        senderIdentity?: {
            type: "profile";
            id: string;
        };
        senderObservation?: {
            type: "observation";
            pluginId: "mattermost";
            accountId: string;
            senderKind: "unknown";
            id: string;
        };
        senderProfileAvatarUrl?: string;
        turnBoundary?: true;
    };
}
interface ProjectedMattermostSession extends Record<string, unknown> {
    key: string;
    agentId: string;
    updatedAt: number;
    lastInteractionAt?: number;
}
interface ControlMessageProjectionInput {
    posts: readonly MattermostModelPost[];
    channelId: string;
    agentId: string;
    agentMmUserId: string;
}
type Authorize = typeof authorizeChannel;
type ListWorkspaceChannels = typeof listWorkspaceChannelCandidates;
export declare function authorizedMattermostSessions(session: OpenClawControlSession, authorize: Authorize, listWorkspaceChannels: ListWorkspaceChannels, signal?: AbortSignal): Promise<ProjectedMattermostSession[]>;
export declare function projectMattermostControlMessages(input: ControlMessageProjectionInput): ProjectedMessage[];
export declare function createMattermostControlChat(options?: {
    perUserIdentity?: boolean;
    allowAttachments?: boolean;
    resolveChatProfile?: OpenClawControlProxyIdentity["resolveChatProfile"];
    authorize?: Authorize;
    listWorkspaceChannels?: ListWorkspaceChannels;
}): MattermostControlChat;
export {};
