export interface ChannelAgentScope {
    workspaceId: string;
    project: string | null;
    channelId: string;
    peerKind: "group" | "channel";
    agentId: string;
}
interface ReadinessSnapshot {
    config: unknown;
    channels: unknown;
    models: unknown;
    session: unknown;
}
export declare function channelAgentReady(scope: ChannelAgentScope, snapshot: ReadinessSnapshot): boolean;
export type ReadinessFailureReason = "agent-repair-required" | "agent-starting" | "platform-unavailable" | "unavailable";
export declare function readinessFailureReason(error: unknown): ReadinessFailureReason;
export declare function readChannelAgentReadiness(scope: ChannelAgentScope): Promise<boolean>;
export {};
