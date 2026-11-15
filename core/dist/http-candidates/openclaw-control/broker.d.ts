export interface OpenClawControlRedemptionResponse {
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    revisionId: string;
    expiresAt: number;
}
export declare const OPENCLAW_CONTROL_BROKER_TIMEOUT_MS = 5000;
export declare const OPENCLAW_CONTROL_AUTHORIZATION_CACHE_TTL_MS = 10000;
export type OpenClawControlBrokerFailureKind = "timeout" | "unavailable";
export declare class OpenClawControlBrokerError extends Error {
    readonly kind: OpenClawControlBrokerFailureKind;
    constructor(kind: OpenClawControlBrokerFailureKind, message: string, options?: ErrorOptions);
}
export declare function openClawControlBrokerFailureKind(error: unknown): OpenClawControlBrokerFailureKind | null;
export declare function postOpenClawControlBroker(path: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<Response>;
export declare function redeemOpenClawControlTicket(args: {
    ticket: string;
    sessionId: string;
    gatewayId: string;
    revisionId: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<OpenClawControlRedemptionResponse | null>;
export declare function authorizeOpenClawControlSession(args: {
    gatewayId: string;
    revisionId: string;
    sessionId: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<boolean>;
type OpenClawControlAuthorizationInput = Parameters<typeof authorizeOpenClawControlSession>[0];
type OpenClawControlAuthorizer = (args: OpenClawControlAuthorizationInput) => Promise<boolean>;
export interface OpenClawControlAuthorizationCacheOptions {
    authorize?: OpenClawControlAuthorizer;
    ttlMs?: number;
    now?: () => number;
}
export declare class OpenClawControlAuthorizationCache {
    private readonly authorized;
    private readonly inFlight;
    private readonly ttlMs;
    private readonly now;
    private readonly authorizeBroker;
    constructor(options?: OpenClawControlAuthorizationCacheOptions);
    authorize(args: OpenClawControlAuthorizationInput, options?: {
        forceRefresh?: boolean;
    }): Promise<boolean>;
    private authorizeFresh;
    private pruneExpired;
}
export declare function createOpenClawControlAuthorizationCache(options?: OpenClawControlAuthorizationCacheOptions): OpenClawControlAuthorizationCache;
export {};
