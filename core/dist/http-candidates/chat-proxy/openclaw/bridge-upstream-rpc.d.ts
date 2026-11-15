import type { WebSocket } from "ws";
export interface UpstreamRpcError {
    code: string;
    message: string;
    details?: unknown;
}
export interface UpstreamRpcFailure {
    ok: false;
    reason: string;
    error?: UpstreamRpcError;
}
export interface UpstreamRpcClient {
    call<T = unknown>(method: string, params: Record<string, unknown>): Promise<{
        ok: true;
        result: T;
    } | UpstreamRpcFailure>;
    dispose(): void;
}
export interface AttachUpstreamRpcOptions {
    timeoutMs?: number;
}
export declare function attachUpstreamRpcClient(ws: WebSocket, opts?: AttachUpstreamRpcOptions): UpstreamRpcClient;
