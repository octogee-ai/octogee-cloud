import type { ChannelAgentScope } from "./channel-agent-readiness.js";
export declare const CHANNEL_READINESS_AUTHORIZATION_PATH = "/internal/channel-agent-readiness/authorize";
export interface ChannelReadinessAuthorization extends ChannelAgentScope {
    gatewayId: string;
    agentMmUserId: string;
}
export type ChannelReadinessAuthorizationOutcome = {
    kind: "authorized";
    authorization: ChannelReadinessAuthorization;
} | {
    kind: "unauthenticated";
} | {
    kind: "not_found";
};
export interface ChannelReadinessAuthorizationRequest {
    gatewayId: string;
    channelId: string;
    authorization: string | undefined;
}
export declare function authorizeChannelAgentReadiness(args: ChannelReadinessAuthorizationRequest & {
    baseUrl?: string;
    env?: Record<string, string | undefined>;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
}): Promise<ChannelReadinessAuthorizationOutcome>;
