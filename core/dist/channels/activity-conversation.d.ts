import type { PlatformUserRecord } from '../platform-state/index.js';
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
export {};
