import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
export type GatewayTokenErrorCode = "empty-token" | "fetch-failed" | "not-configured" | "invalid-gateway-id" | "device-token-persist-failed";
export declare class GatewayTokenError extends Error {
    readonly code: GatewayTokenErrorCode;
    readonly name = "GatewayTokenError";
    constructor(code: GatewayTokenErrorCode, message: string);
}
export declare const DEFAULT_OPENCLAW_DEVICE_TOKEN_PATH = "/var/run/octogee/openclaw-device-auth/token";
export interface FetchGatewayTokenOptions {
    gatewayId: string;
    projectId?: string;
    client?: Pick<SecretManagerServiceClient, "accessSecretVersion">;
    skipCache?: boolean;
}
export interface FetchGatewayAuthOptions extends FetchGatewayTokenOptions {
    allowLegacyFallback?: boolean;
    deviceTokenPath?: string;
}
export type GatewayOpenClawAuth = {
    source: "device-token-file";
    deviceToken: string;
    token?: undefined;
} | {
    source: "legacy-token";
    token: string;
    deviceToken?: undefined;
} | {
    source: "trusted-proxy";
    token?: undefined;
    deviceToken?: undefined;
};
export declare function fetchGatewayToken(opts: FetchGatewayTokenOptions): Promise<string>;
export declare function fetchGatewayAuth(opts: FetchGatewayAuthOptions): Promise<GatewayOpenClawAuth>;
export declare function persistGatewayDeviceToken(opts: {
    token: string;
    deviceTokenPath?: string;
}): Promise<void>;
export declare function clearGatewayDeviceToken(deviceTokenPath?: string): Promise<void>;
export declare function invalidateGatewayToken(gatewayId: string): void;
export declare function __resetGatewayTokenCacheForTest(): void;
