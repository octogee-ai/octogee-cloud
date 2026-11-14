export interface AgentStoreGatewayIdentity {
    gatewayId: string;
    gatewayClass: "shared" | "isolated";
    token: string;
    user?: {
        uid: string;
        slug: string;
    };
}
export interface AgentStoreHandoffIdentity {
    agentId: string;
    storeId: string;
    schema: string;
}
export declare function createAgentStoreCredentialProvisioner(adminDsn: string, clientDsn: string): (identity: AgentStoreGatewayIdentity, assertCurrent: () => Promise<void>) => Promise<string>;
export declare function createAgentStoreCredentialRevoker(adminDsn: string): (gatewayId: string, assertCurrent: () => Promise<void>) => Promise<void>;
export declare function createAgentStoreCredentialRetirementVerifier(adminDsn: string): (gatewayId: string, assertCurrent: () => Promise<void>) => Promise<boolean>;
export declare function createAgentStoreOwnershipTransferer(adminDsn: string, readStores: (user: {
    uid: string;
    slug: string;
}) => Promise<readonly AgentStoreHandoffIdentity[]>): (user: {
    uid: string;
    slug: string;
}, target: "shared" | "isolated", assertCurrent?: () => Promise<void>) => Promise<void>;
export declare function assertNoUserAgentStores(adminDsn: string, user: {
    uid: string;
    slug: string;
}): Promise<void>;
type AgentStoreErasureIdentity = {
    family: "agent";
    role: "agent";
    storeId: string;
    agentId: string;
} | {
    family: "state";
    role: "global";
    storeId: string;
    agentId: null;
};
export type AgentStoreErasureTarget = AgentStoreErasureIdentity & {
    namespace: string;
    namespaceOid: string;
    owner: string;
};
export declare class AgentStoreErasureRetainedLoginError extends Error {
    readonly name: string;
}
export interface AgentStoreErasureCustody {
    assertCurrent(): Promise<void>;
    assertWritersStopped(targets: readonly AgentStoreErasureTarget[]): Promise<readonly string[]>;
    bindTargets(targets: readonly AgentStoreErasureTarget[]): Promise<readonly AgentStoreErasureTarget[]>;
}
export declare function eraseUserAgentStores(adminDsn: string, user: {
    uid: string;
    slug: string;
}, custody: AgentStoreErasureCustody): Promise<void>;
export {};
