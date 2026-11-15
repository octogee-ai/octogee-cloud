export declare const CONNECTOR_APPROVAL_PLUGIN = "octogee-connector-tools";
export declare const CONNECTOR_APPROVAL_TIMEOUT_MS = 600000;
export declare class NativeConnectorApprovalAccessError extends Error {
    readonly status = 403;
    readonly code = "approval_forbidden";
}
interface Binding {
    gatewayId: string;
    ownerUid: string;
    agentId: string;
}
export type NativeConnectorCommand = Binding & ({
    operation: "create";
    title: string;
    detail: string;
    actionUrl: string;
    coachChannelId: string;
} | {
    operation: "get";
    nativeId: string;
    reviewerUid?: string;
} | {
    operation: "resolve";
    nativeId: string;
    reviewerUid: string;
    decision: "deny";
});
export interface NativeApprovalSnapshot {
    id: string;
    status: "pending" | "allowed" | "denied" | "expired" | "cancelled";
    expiresAtMs: number;
    decision?: "allow-once" | "allow-always" | "deny";
    presentation: {
        kind: string;
        pluginId?: string | null;
        agentId?: string | null;
    };
}
export interface NativeApprovalClient {
    scopes: Set<string>;
    call: (method: string, params: Record<string, unknown>) => Promise<{
        ok: true;
        result: unknown;
    } | {
        ok: false;
        reason: string;
    }>;
    close: () => void;
}
export declare function nativeApprovalViewState(snapshot: NativeApprovalSnapshot): "pending" | "approved" | "denied" | "expired";
export declare function parseNativeApproval(value: unknown, binding: {
    nativeId: string;
    agentId: string;
}): NativeApprovalSnapshot;
interface NativeApprovalDeps {
    isolated: boolean;
    openService: () => Promise<NativeApprovalClient>;
    openUser: (uid: string, gatewayId: string) => Promise<NativeApprovalClient>;
}
export declare function runNativeConnectorApproval(command: NativeConnectorCommand, deps: NativeApprovalDeps): Promise<unknown>;
export {};
