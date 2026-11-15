export { trustedBrokerBaseUrl } from "../trusted-broker-url.js";
export type AutomationAuthorizationOutcome = {
    kind: "authorized";
    slug: string;
    gatewayId: string;
    coachChannelId: string;
} | {
    kind: "unauthenticated";
} | {
    kind: "forbidden";
} | {
    kind: "not_found";
} | {
    kind: "coach_channel_not_ready";
};
export declare function automationAuthorizationBrokerBaseUrlFromEnv(env?: Record<string, string | undefined>): string;
export declare function authorizeAutomationOwner(args: {
    gatewayId: string;
    authorization?: string;
    baseUrl?: string;
    env?: Record<string, string | undefined>;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<AutomationAuthorizationOutcome>;
