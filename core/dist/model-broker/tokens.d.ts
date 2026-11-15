import type { PlatformStateStore } from "../platform-state/index.js";
export type ModelBrokerProvider = "anthropic" | "vertex" | "openrouter" | "openai" | "meta";
export type ModelBrokerTokenPurpose = "model" | "embeddings";
export interface ModelBrokerTokenLimits {
    spendWindowUsd: number | null;
    spendWeekUsd: number | null;
    requestsPerMinute: number | null;
}
export interface ModelBrokerTokenPolicy {
    freeTier: boolean;
    houseFallback: boolean;
}
export type ModelBrokerTokenTraceSource = "gateway_model_key_issuer" | "shared_agent_model_token";
export interface ModelBrokerTokenTrace {
    source: ModelBrokerTokenTraceSource;
    ownerSlug: string | null;
    agentId: string | null;
}
export interface ModelBrokerTokenRecord {
    tokenHash: string;
    gatewayId: string;
    ownerUid: string | null;
    provider: ModelBrokerProvider;
    purpose: ModelBrokerTokenPurpose;
    capped: true;
    secretName: string;
    createdAt: number;
    expiresAt: number | null;
    limits: ModelBrokerTokenLimits;
    policy: ModelBrokerTokenPolicy;
    trace: ModelBrokerTokenTrace | null;
    revoked: boolean;
    revokedAt?: number;
}
export interface IssueModelBrokerTokenInput {
    gatewayId: string;
    ownerUid?: string;
    provider: ModelBrokerProvider;
    purpose?: ModelBrokerTokenPurpose;
    secretName: string;
    pointerKey?: string;
    skipPointer?: boolean;
    ttlSeconds?: number | null;
    limits?: Partial<ModelBrokerTokenLimits> | null;
    policy?: Partial<ModelBrokerTokenPolicy> | null;
    trace?: Partial<ModelBrokerTokenTrace> | null;
    now?: number;
    randomBytes?: (size: number) => Buffer;
}
export interface RevokeModelBrokerTokenInput {
    gatewayId: string;
    ownerUid?: string;
    provider: ModelBrokerProvider;
    secretName: string;
    pointerKey?: string;
    now?: number;
}
export type ModelBrokerTokenLookup = {
    outcome: "valid";
    record: ModelBrokerTokenRecord;
} | {
    outcome: "expired";
    record: ModelBrokerTokenRecord;
} | {
    outcome: "revoked";
    record: ModelBrokerTokenRecord;
} | {
    outcome: "unknown";
};
export interface ModelBrokerTokenStore {
    issueToken(input: IssueModelBrokerTokenInput): Promise<{
        token: string;
        record: ModelBrokerTokenRecord;
    }>;
    revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{
        revoked: boolean;
    }>;
    lookupToken(token: string, now?: number): Promise<ModelBrokerTokenLookup>;
}
export declare function hashModelBrokerToken(token: string): string;
export declare function normalizeModelBrokerTokenLimits(limits: Partial<ModelBrokerTokenLimits> | null | undefined): ModelBrokerTokenLimits;
export declare function normalizeModelBrokerTokenPolicy(policy: {
    readonly freeTier?: unknown;
    readonly houseFallback?: unknown;
} | null | undefined): ModelBrokerTokenPolicy;
export declare class InMemoryModelBrokerTokenStore implements ModelBrokerTokenStore {
    private readonly tokens;
    private readonly pointers;
    issueToken(input: IssueModelBrokerTokenInput): Promise<{
        token: string;
        record: ModelBrokerTokenRecord;
    }>;
    revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{
        revoked: boolean;
    }>;
    lookupToken(token: string, now?: number): Promise<ModelBrokerTokenLookup>;
}
export declare function createModelBrokerTokenStore(state: PlatformStateStore): ModelBrokerTokenStore;
