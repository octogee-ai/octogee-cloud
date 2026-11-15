import http from "node:http";
export interface AgentControlRouterProof {
    gatewayId: string;
    timestamp: string;
    signature: string;
}
export declare function validAgentControlRouterPublicKey(key: string): boolean;
export declare function signAgentControlRouterRequest(body: Buffer, gatewayId: string, timestamp: string, key: string): string;
export declare const CONTROL_UI_COMMAND = "control-ui";
export interface MattermostCommandProof {
    command: string;
    timestamp: string;
    signature: string;
}
export declare function signMattermostCommandRequest(body: Buffer, command: string, timestamp: string, key: string): string;
export declare function verifyMattermostCommandRequest(body: Buffer, proof: MattermostCommandProof, key: string, now: number): boolean;
export declare function verifyAgentControlRouterRequest(body: Buffer, proof: AgentControlRouterProof, key: string, now: number): boolean;
export declare function createAgentControlCallbackRouter(input: {
    namespace: string;
    signingKey: string;
    now?: () => number;
    resolveVmOrigin?: (gatewayId: string) => string | undefined;
    targetOrigin?: (gatewayId: string) => string;
    apiOrigin?: string;
    upstreamTimeoutMs?: number;
    maxResponseBytes?: number;
    log: (message: string, meta?: Record<string, unknown>) => void;
}): http.Server;
