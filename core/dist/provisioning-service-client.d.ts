import { type ProvisioningCredential, type ProvisioningCredentialName, type ProvisioningErrorCode, type ProvisioningEventsResponse, type RetryProvisioningRequest, type UserProvisioning, type UserProvisioningList, type UserProvisioningListQuery, type UserProvisioningSpec, type UserProvisioningWatchResponse } from "@octogee/shared/types/provisioning-service";
export declare const PROVISIONING_SERVICE_URL_ENV = "PROVISIONING_SERVICE_URL";
export declare const PROVISIONING_SERVICE_TOKEN_PATH_ENV = "PROVISIONING_SERVICE_TOKEN_PATH";
export interface ProvisioningServiceRetryPolicy {
    readonly attempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
}
export declare const DEFAULT_PROVISIONING_SERVICE_RETRY: ProvisioningServiceRetryPolicy;
export type ProvisioningServiceRequestOutcome = "ok" | "client-error" | "server-error" | "unreachable";
export interface ProvisioningServiceClientOptions {
    readonly baseUrl: string;
    readonly tokenPath: string;
    readonly fetch?: typeof fetch;
    readonly readToken?: (path: string) => Promise<string>;
    readonly retry?: ProvisioningServiceRetryPolicy;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly now?: () => number;
    readonly onRequest?: (outcome: ProvisioningServiceRequestOutcome) => void;
}
export declare class ProvisioningServiceError extends Error {
    readonly status: number;
    readonly code: ProvisioningErrorCode | "unreachable" | "unexpected-response";
    readonly retryAfterMs: number | null;
    constructor(status: number, code: ProvisioningErrorCode | "unreachable" | "unexpected-response", message: string, retryAfterMs?: number | null);
    get transient(): boolean;
}
export interface PutProvisioningResult {
    readonly outcome: "created" | "changed" | "unchanged";
    readonly resource: UserProvisioning;
}
export interface GetProvisioningOptions {
    readonly waitForGeneration?: number;
    readonly timeoutSeconds?: number;
}
export interface WatchProvisioningsOptions {
    readonly resourceVersion: string;
    readonly timeoutSeconds?: number;
}
export interface ProvisioningServiceClient {
    putProvisioning(uid: string, spec: UserProvisioningSpec, options?: {
        expectedResourceVersion?: string;
    }): Promise<PutProvisioningResult>;
    getProvisioning(uid: string, options?: GetProvisioningOptions): Promise<UserProvisioning | null>;
    deleteProvisioning(uid: string): Promise<void>;
    listProvisionings(query?: UserProvisioningListQuery): Promise<UserProvisioningList>;
    listAllProvisionings(query?: Omit<UserProvisioningListQuery, "pageToken">): Promise<UserProvisioningWatchResponse>;
    watchProvisionings(options: WatchProvisioningsOptions): Promise<UserProvisioningWatchResponse>;
    retryProvisioning(uid: string, request: RetryProvisioningRequest, idempotencyKey: string): Promise<unknown>;
    getProvisioningEvents(uid: string): Promise<ProvisioningEventsResponse | null>;
    getCredential(uid: string, name: ProvisioningCredentialName): Promise<ProvisioningCredential | null>;
}
export interface ProvisioningServiceConfig {
    readonly baseUrl: string;
    readonly tokenPath: string;
}
export declare function provisioningServiceConfigFromEnvironment(env: NodeJS.ProcessEnv): ProvisioningServiceConfig | null;
export declare function isAddressableUid(uid: string): boolean;
export declare function backoffDelayMs(attempt: number, policy: Pick<ProvisioningServiceRetryPolicy, "baseDelayMs" | "maxDelayMs">, random: () => number): number;
export declare function createProvisioningServiceClient(options: ProvisioningServiceClientOptions): ProvisioningServiceClient;
export interface ProvisioningWatchHandlers {
    onSnapshot(items: readonly UserProvisioning[]): Promise<void>;
    onChanges(items: readonly UserProvisioning[]): Promise<void>;
    onError(error: unknown, consecutiveFailures: number): void;
}
export interface ProvisioningWatchOptions {
    readonly timeoutSeconds?: number;
    readonly retry?: Pick<ProvisioningServiceRetryPolicy, "baseDelayMs" | "maxDelayMs">;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
}
export declare const PROVISIONING_WATCH_RETRY: {
    readonly baseDelayMs: 1000;
    readonly maxDelayMs: 60000;
};
export declare function startProvisioningWatch(client: Pick<ProvisioningServiceClient, "listAllProvisionings" | "watchProvisionings">, handlers: ProvisioningWatchHandlers, options?: ProvisioningWatchOptions): {
    stop(): void;
    stopped: Promise<void>;
};
