import type { ConnectorId, ConnectorMeta } from "@octogee/shared/types/connectors";
export interface ConnectorOAuthWebDef {
    authorizeUrl: string;
    tokenUrl: string;
    revocationUrl?: string;
    clientIdEnv: string;
    clientSecretEnv: string;
    redirectUriEnv: string;
    pkce?: boolean;
    accountHintParam?: string;
    extraAuthParams?: Record<string, string>;
}
export interface ConnectorDeviceDef {
    codeUrl: string;
    tokenUrl: string;
    clientIdEnv: string;
}
export interface ConnectorIdentity {
    accountLabel: string;
}
export interface ConnectorProbeResult {
    probe: string;
    detail: string;
}
export interface ConnectorDef {
    meta: ConnectorMeta;
    oauth?: ConnectorOAuthWebDef;
    device?: ConnectorDeviceDef;
    capabilityRequestScopes?: (capability: string) => string[] | null;
    fetchIdentity: (accessToken: string) => Promise<ConnectorIdentity>;
    deepProbe?: (accessToken: string, grantedScopes?: string[]) => Promise<ConnectorProbeResult>;
    validateFields?: (fields: Record<string, string>) => Promise<ConnectorIdentity>;
    validateStoredFields?: (fields: Record<string, string>) => Promise<ConnectorIdentity>;
    revokeStoredFields?: (fields: Record<string, string>) => Promise<void>;
}
export declare function catalogMeta(id: ConnectorId): ConnectorMeta;
