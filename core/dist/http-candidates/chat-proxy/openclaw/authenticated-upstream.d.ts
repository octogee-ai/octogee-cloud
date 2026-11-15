import type { WebSocket } from "ws";
import type { DeviceIdentity } from "@octogee/shared/types/device-identity";
import { type FetchGatewayAuthOptions, type GatewayOpenClawAuth } from "./gateway-token.js";
import { type OpenUpstreamParams, type RequestDevicePairBootstrapTokenParams } from "./upstream.js";
export interface AuthenticatedUpstreamDeps {
    fetchGatewayAuth(opts: FetchGatewayAuthOptions): Promise<GatewayOpenClawAuth>;
    serviceClientAddress(): string | undefined;
    openUpstream(params: OpenUpstreamParams): Promise<WebSocket>;
    requestDevicePairBootstrapToken(params: RequestDevicePairBootstrapTokenParams): Promise<string>;
    clearGatewayDeviceToken(): Promise<void>;
    invalidateGatewayToken(gatewayId: string): void;
    persistGatewayDeviceToken(opts: {
        token: string;
    }): Promise<void>;
    getIdentity(): DeviceIdentity;
}
export interface AuthenticatedUpstreamOptions {
    gatewayId: string;
    url: string;
    pairingUrl?: string;
    timeoutMs?: number;
}
export declare function openUpstreamWithGatewayAuth(opts: AuthenticatedUpstreamOptions, auth: GatewayOpenClawAuth, deps?: AuthenticatedUpstreamDeps): Promise<WebSocket>;
export declare function openAuthenticatedUpstream(opts: AuthenticatedUpstreamOptions, deps?: AuthenticatedUpstreamDeps): Promise<WebSocket>;
