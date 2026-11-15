import { WebSocket } from "ws";
import { OpenclawWireError, type OpenclawWireErrorCode } from "@octogee/shared/types/openclaw-wire-core";
import { type DeviceIdentity } from "@octogee/shared/types/device-identity";
export { OpenclawWireError, type OpenclawWireErrorCode, };
export interface OpenUpstreamProxyIdentity {
    headers: Record<string, string>;
}
export interface OpenUpstreamParams {
    url: string;
    token?: string;
    bootstrapToken?: string;
    deviceToken?: string;
    proxyIdentity?: OpenUpstreamProxyIdentity;
    identity: DeviceIdentity;
    scopes?: string[];
    timeoutMs?: number;
    onDeviceToken?: (auth: {
        deviceToken: string;
        role?: string;
        scopes?: string[];
    }) => void | Promise<void>;
}
export interface RequestDevicePairBootstrapTokenParams {
    ws: WebSocket;
    url: string;
    timeoutMs: number;
}
export declare function requestDevicePairBootstrapToken(params: RequestDevicePairBootstrapTokenParams): Promise<string>;
export declare function openUpstream(params: OpenUpstreamParams): Promise<WebSocket>;
