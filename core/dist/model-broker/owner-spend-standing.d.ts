import { type ModelAccess, type SpendThrottleState } from "@octogee/shared/types/model-broker-usage";
import type { FundedBudgetLedger } from "./budget.js";
import type { ModelBrokerRailRegistry, OwnerRailProfile } from "./rails.js";
import type { ModelBrokerUsageLedger } from "./usage.js";
export declare const SPEND_ATTENTION_PERCENT = 80;
export interface SpendMeterReading {
    usedUsd: number;
    limitUsd: number;
    percentUsed: number;
    resetsAt: string;
}
export type OwnerSpendMeter = {
    kind: "owner_credential";
} | {
    kind: "funded_budget";
    usedUsd: number;
    availableUsd: number;
    hardCapUsd: number;
    percentUsed: number;
    nextIncreaseAt: string | null;
    endsAt: string;
} | {
    kind: "funded_budget_unavailable";
} | {
    kind: "spend_windows";
    week: SpendMeterReading;
    window: SpendMeterReading;
} | {
    kind: "balance";
    balanceUsd: number;
} | {
    kind: "unmetered";
};
export interface OwnerSpendStanding {
    rail: string;
    meter: OwnerSpendMeter;
    balanceUsd: number | null;
    throttle: SpendThrottleState;
    needsAttention: boolean;
}
export interface OwnerSpendObservation {
    profile: OwnerRailProfile | null;
    modelAccess: ModelAccess;
    onOwnerCredential: boolean;
    windowCostUsd: number;
    weekCostUsd: number;
    balanceUsd: number | null;
    fundedLedger: FundedBudgetLedger | null;
    now: number;
}
export declare function ownerSpendStanding(rails: ModelBrokerRailRegistry, input: OwnerSpendObservation): OwnerSpendStanding;
export interface OwnerSpendReadInput {
    rails: ModelBrokerRailRegistry;
    usage: ModelBrokerUsageLedger;
    ownerUid: string;
    gatewayId: string;
    planInputs: Readonly<Record<string, unknown>>;
    modelAccess: ModelAccess;
    onOwnerCredential: boolean;
    now: number;
}
export declare function readOwnerSpendStanding(input: OwnerSpendReadInput): Promise<OwnerSpendStanding>;
