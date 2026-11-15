import type { UserAccountReader } from "../user-account.js";
import { type GatewayAuthorization, type GatewayRootReader } from "../gateway-live-release.js";
import { type ModelBrokerTokenLimits, type ModelBrokerTokenPolicy } from "./tokens.js";
import type { FundedBudget } from "./budget.js";
import type { ModelBrokerRailRegistry } from "./rails.js";
export interface OwnerModelBrokerGrant {
    limits: ModelBrokerTokenLimits;
    policy: ModelBrokerTokenPolicy;
    rail: string;
    fundedBudget?: FundedBudget | null;
}
export interface ModelBrokerGrantReaders {
    readonly state: GatewayRootReader;
    readonly accounts: UserAccountReader;
}
export declare function parseOptionalLimitNumber(raw: string | undefined): number | null;
export declare function envDefaultModelBrokerLimits(env?: NodeJS.ProcessEnv): Partial<ModelBrokerTokenLimits>;
export declare function resolveOwnerModelBrokerGrant(input: ModelBrokerGrantReaders & {
    gatewayId: string;
    ownerUid?: string;
    now: number;
    defaults?: Partial<ModelBrokerTokenLimits> | null;
    gatewayAuthorization?: GatewayAuthorization;
    rails: ModelBrokerRailRegistry;
}): Promise<OwnerModelBrokerGrant>;
export interface LiveOwnerGrantInput {
    gatewayId: string;
    ownerUid: string | null;
    now: number;
}
export type LiveOwnerGrantResolver = (input: LiveOwnerGrantInput) => Promise<OwnerModelBrokerGrant>;
export declare function createCachedOwnerModelBrokerGrantResolver(opts: ModelBrokerGrantReaders & {
    rails: ModelBrokerRailRegistry;
    defaults?: Partial<ModelBrokerTokenLimits> | null;
    ttlMs?: number;
    maxEntries?: number;
    log?: (msg: string, fields?: Record<string, unknown>) => void;
}): LiveOwnerGrantResolver;
