import type { PlatformStateStore, PlatformUserRecord } from '../platform-state/index.js';
import { authorizeChannel } from './channel-session-authorization.js';
export interface ActivityConversation {
    gatewayId: string;
    ownerUid: string;
    channelId: string;
    threadRootPostId?: string;
    expectedAgentId: string;
    sessionKey: string;
}
interface ActivityConversationInput {
    users: {
        get(uid: string): Promise<PlatformUserRecord | null>;
    };
    uid: string;
    channelId: string;
    threadRootPostId?: string;
    authorize?: typeof authorizeChannel;
}
export declare function resolveActivityConversation(input: ActivityConversationInput): Promise<ActivityConversation | null>;
export declare function resolveChannelRunControlConversation(input: ActivityConversationInput, workspaces: PlatformStateStore['workspaces']): Promise<{
    gatewayId: string;
    ownerUid: string;
    channelId: string;
    expectedAgentId: string;
    threadRootPostId?: string | undefined;
    sessionKey: string;
    callerMmUserId: string;
    isOwner: boolean;
} | null>;
export {};
