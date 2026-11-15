import { MODEL_BROKER_USAGE_EVENTS_COLLECTION, MODEL_BROKER_USAGE_ROLLUPS_COLLECTION, MODEL_BROKER_USAGE_WINDOWS_COLLECTION, MODEL_BROKER_RATE_WINDOWS_COLLECTION, rateWindowStartMs, usageWindowStartMs, windowOwnerKey } from "@octogee/shared/types/model-broker-usage";
import type { ModelBrokerUsageLedger as PlatformUsageLedger } from "../model-broker-usage-ledger.js";
import { type FundedBudgetLedger, type FundedBudgetLedgerRef } from "./budget.js";
export type ModelBrokerUsageProvider = "anthropic" | "vertex" | "openrouter" | "openai" | "meta" | "brave" | "tavily";
export type AnthropicCacheWriteTtl = "5m" | "1h";
export interface AnthropicTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
}
export type ModelBrokerCostSource = "estimated" | "openrouter_reported" | "provider_reported";
export interface ModelBrokerUsageCost {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    pricingModel: string;
    cacheWriteTtl: AnthropicCacheWriteTtl;
    source: ModelBrokerCostSource;
}
export type ModelBrokerUsageProviderKeySource = "platform" | "owner_model_credential";
export interface ModelBrokerUsageRecordInput {
    eventId?: string;
    requestId: string;
    upstreamId?: string | null;
    provider: ModelBrokerUsageProvider;
    gatewayId: string;
    ownerUid: string | null;
    brokerTokenHash?: string | null;
    brokerTokenSecretName?: string | null;
    providerKeySource?: ModelBrokerUsageProviderKeySource | null;
    providerKeySecretName?: string | null;
    degraded?: boolean;
    model: string;
    usage: AnthropicTokenUsage;
    cacheWriteTtl?: AnthropicCacheWriteTtl;
    method: string;
    path: string;
    upstreamStatus: number;
    now?: number;
    countsTowardSpendWindow?: boolean;
    priceMultiplier?: number;
    balanceDebit?: BalanceLedgerRef | null;
    fundedBudget?: FundedBudgetLedgerRef;
    reportedCostUsd?: number | null;
    chargeUsd?: number;
    usageKind?: "model" | "embedding" | "web_search" | "web_extract";
    agentId?: string | null;
    toolName?: string | null;
    providerMetadata?: Record<string, unknown>;
}
export interface BalanceLedgerRef {
    collection: string;
    ownerUid: string;
}
export declare function requirePriceMultiplier(value: unknown): number;
export interface ModelBrokerUsageStore {
    recordUsage(input: ModelBrokerUsageRecordInput): Promise<void>;
    readWindowUsage?(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerUsageWindowSnapshot>;
    readWeekUsage?(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerWeekSnapshot>;
    reserveRateWindow?(input: ModelBrokerRateWindowReserveInput): Promise<ModelBrokerRateWindowSnapshot>;
    readBalance?(ref: BalanceLedgerRef): Promise<number>;
    readFundedBudgetLedger?(ref: FundedBudgetLedgerRef): Promise<FundedBudgetLedger | null>;
}
export type ModelBrokerUsageLedger = Required<ModelBrokerUsageStore>;
export declare const UNCONFIGURED_MODEL_BROKER_USAGE: ModelBrokerUsageLedger;
export interface ModelBrokerWeekSnapshot {
    ownerKey: string;
    weekStartMs: number;
    requestCount: number;
    totalTokens: number;
    costUsd: number;
    chargeUsd: number;
}
export interface ModelBrokerUsageWindowReadInput {
    gatewayId: string;
    ownerUid?: string | null;
    now?: number;
}
export interface ModelBrokerUsageWindowSnapshot {
    ownerKey: string;
    windowStartMs: number;
    requestCount: number;
    totalTokens: number;
    costUsd: number;
    chargeUsd: number;
}
export interface ModelBrokerRateWindowReserveInput {
    gatewayId: string;
    ownerUid?: string | null;
    scope?: "embedding";
    now?: number;
}
export interface ModelBrokerRateWindowSnapshot {
    ownerKey: string;
    windowStartMs: number;
    requestCount: number;
}
export { MODEL_BROKER_USAGE_EVENTS_COLLECTION, MODEL_BROKER_USAGE_ROLLUPS_COLLECTION, MODEL_BROKER_USAGE_WINDOWS_COLLECTION, MODEL_BROKER_RATE_WINDOWS_COLLECTION, rateWindowStartMs, usageWindowStartMs, windowOwnerKey, };
export declare function normalizeAnthropicUsage(value: unknown): AnthropicTokenUsage | null;
export declare function totalTokens(usage: AnthropicTokenUsage): number;
export declare function mergeAnthropicUsage(current: AnthropicTokenUsage | null, next: AnthropicTokenUsage | null): AnthropicTokenUsage | null;
export declare function isUnknownAnthropicPricingModel(pricingModel: string): boolean;
export declare function estimateAnthropicCost(model: string, usage: AnthropicTokenUsage, cacheWriteTtl?: AnthropicCacheWriteTtl): ModelBrokerUsageCost;
export declare function isUnknownOpenAiPricingModel(pricingModel: string): boolean;
export declare function estimateModelBrokerCost(provider: ModelBrokerUsageProvider, model: string, usage: AnthropicTokenUsage, cacheWriteTtl?: AnthropicCacheWriteTtl): ModelBrokerUsageCost;
export declare function resolveRecordedCost(input: Pick<ModelBrokerUsageRecordInput, "provider" | "model" | "usage" | "reportedCostUsd">, cacheWriteTtl: AnthropicCacheWriteTtl): ModelBrokerUsageCost;
export declare function resolvedChargeUsd(input: ModelBrokerUsageRecordInput, cost: ModelBrokerUsageCost): number;
export declare function isUnknownOpenRouterPricingModel(pricingModel: string): boolean;
export declare function modelRollupKey(model: string): string;
export declare function rateWindowOwnerKey(input: ModelBrokerRateWindowReserveInput): string;
export declare function usageExpiresAt(now: number): Date;
export declare function numberField(data: Record<string, unknown>, key: string): number;
export declare function chargeField(data: Record<string, unknown>): number;
export declare function usageDocumentTotals(existing: Record<string, unknown>, usage: AnthropicTokenUsage, cost: ModelBrokerUsageCost, chargeUsd: number): Record<string, unknown>;
export declare function modelTotals(input: {
    existing: Record<string, unknown>;
    modelKey: string;
    model: string;
    provider: ModelBrokerUsageProvider;
    usage: AnthropicTokenUsage;
    cost: ModelBrokerUsageCost;
    chargeUsd: number;
}): Record<string, unknown>;
export declare function latestTraceFields(input: ModelBrokerUsageRecordInput): Record<string, unknown>;
export declare function eventDocument(input: ModelBrokerUsageRecordInput & {
    eventId: string;
    now: number;
    cacheWriteTtl: AnthropicCacheWriteTtl;
    cost: ModelBrokerUsageCost;
    chargeUsd: number;
    windowStartMs: number;
}): Record<string, unknown>;
export declare function requireFundedBudgetLedger(value: unknown, ref: FundedBudgetLedgerRef): FundedBudgetLedger;
export declare function fundedBudgetCharge(ledger: FundedBudgetLedger, ref: FundedBudgetLedgerRef, usage: AnthropicTokenUsage, chargeUsd: number, now: number): FundedBudgetLedger & {
    expiresAt: Date;
};
export declare class InMemoryModelBrokerUsageStore implements ModelBrokerUsageStore {
    readonly events: Array<Record<string, unknown>>;
    readonly rollups: Map<string, Record<string, unknown> & {
        totalTokens: number;
        costUsd: number;
        chargeUsd: number;
        requestCount: number;
    }>;
    readonly windows: Map<string, ModelBrokerUsageWindowSnapshot & Record<string, unknown>>;
    readonly weekWindows: Map<string, ModelBrokerWeekSnapshot & Record<string, unknown>>;
    readonly rateWindows: Map<string, ModelBrokerRateWindowSnapshot>;
    readonly balances: Map<string, number>;
    readonly fundedBudgetLedgers: Map<string, Record<string, unknown>>;
    private readonly eventIds;
    setBalance(ref: BalanceLedgerRef, balanceUsd: number): void;
    recordUsage(input: ModelBrokerUsageRecordInput): Promise<void>;
    readBalance(ref: BalanceLedgerRef): Promise<number>;
    readFundedBudgetLedger(ref: FundedBudgetLedgerRef): Promise<FundedBudgetLedger | null>;
    readWindowUsage(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerUsageWindowSnapshot>;
    readWeekUsage(input: ModelBrokerUsageWindowReadInput): Promise<ModelBrokerWeekSnapshot>;
    reserveRateWindow(input: ModelBrokerRateWindowReserveInput): Promise<ModelBrokerRateWindowSnapshot>;
}
export type LedgerModelBrokerUsageStore = Pick<Required<ModelBrokerUsageStore>, "recordUsage" | "readWindowUsage" | "readWeekUsage" | "reserveRateWindow">;
export declare function createLedgerModelBrokerUsageStore(ledger: PlatformUsageLedger): LedgerModelBrokerUsageStore;
