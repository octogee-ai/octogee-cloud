import type { PlatformStateStore } from "../platform-state/index.js";
import type { ConnectorDef } from "./def.js";
export declare function connectorTokenBrokerBaseUrlFromEnv(env?: Record<string, string | undefined>): string | null;
export declare function connectorTokenAuthorityFromEnv(env?: Record<string, string | undefined>): boolean;
export interface ConnectorTokenProjectAccessContext {
    kind: "project";
    requestingUid: string;
    workspaceSlug: string;
    projectSlug: string;
}
export interface ConnectorTokenOwnerRuntimeAccessContext {
    kind: "owner-runtime";
    builderSlug: string;
}
export interface ConnectorTokenPublicCanvasAccessContext {
    kind: "public-canvas";
    workspaceSlug: string;
    projectSlug: string;
    canvasPath: string;
}
export interface ConnectorTokenProjectCloneAccessContext {
    kind: "project-clone";
    builderSlug: string;
    projectSlug: string;
}
export type ConnectorTokenAccessContext = ConnectorTokenProjectAccessContext | ConnectorTokenOwnerRuntimeAccessContext | ConnectorTokenPublicCanvasAccessContext | ConnectorTokenProjectCloneAccessContext;
export declare class ConnectorTokenReadError extends Error {
    readonly status: number;
    readonly errorCode: string;
    constructor(status: number, errorCode: string, message?: string);
}
export declare class ConnectorTokenBrokerError extends ConnectorTokenReadError {
    constructor(status: number, errorCode: string);
}
export declare function readConnectorAccessToken(uid: string, connectorId: string, access?: ConnectorTokenAccessContext): Promise<string | null>;
export declare function readOwnerRuntimeConnectorAccessToken(connectorId: string): Promise<string | null>;
export interface GithubProjectCloneAccess {
    accessToken: string;
    repository: {
        owner: string;
        repo: string;
    };
}
export declare function readOwnerGithubProjectCloneAccess(projectSlug: string): Promise<GithubProjectCloneAccess | null>;
export interface ConnectorClientCreds {
    clientId: string;
    clientSecret: string;
}
export type ConnectorTokenStore = Pick<PlatformStateStore, "secrets" | "transaction">;
export declare function configuredEnvValue(value: string | undefined): string | null;
export declare function readConnectorClientCreds(def: ConnectorDef): ConnectorClientCreds | null;
export type FreshTokenResult = {
    ok: true;
    accessToken: string;
} | {
    ok: false;
    reason: "not_connected" | "reauth_required";
};
export declare function getFreshAccessToken(uid: string, def: ConnectorDef): Promise<FreshTokenResult>;
export declare function getFreshAccessTokenFromStore(store: ConnectorTokenStore, uid: string, def: ConnectorDef): Promise<FreshTokenResult>;
