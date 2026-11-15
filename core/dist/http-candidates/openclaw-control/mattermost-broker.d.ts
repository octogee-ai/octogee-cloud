import type { authorizeChannel, listWorkspaceChannelCandidates } from "../../channels/channel-session-authorization.js";
import type { OpenClawControlSession } from "./session.js";
export declare function createBrokeredMattermostAccess(session: OpenClawControlSession, options?: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): {
    authorize: typeof authorizeChannel;
    listWorkspaceChannels: typeof listWorkspaceChannelCandidates;
    watchChannel: (channelId: string, agentId: string, onChange: () => void, signal: AbortSignal) => Promise<void>;
};
