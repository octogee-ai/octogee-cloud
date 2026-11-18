import { type ModelAccess, type SpendThrottleState } from "@octogee/shared/types/model-broker-usage";
import type { FundedBudget, FundedBudgetInterruptionHandler, FundedBudgetLedger } from "./budget.js";
import type { DegradeOutcome, GateDecisionAllowed, RailGateContext, SpendBudgets } from "./gate.js";
import type { OwnerModelBrokerGrant } from "./limits.js";
import type { BalanceLedgerRef, ModelBrokerUsageStore } from "./usage.js";
export interface OwnerRailProfile {
    rail: string;
    spendWindowUsd: number;
    spendWeekUsd: number;
    windowBudgets: boolean;
    freeTier: boolean;
    houseFallback: boolean;
    fundedBudget: FundedBudget | null;
}
export interface RailAllowanceInput {
    usageStore: ModelBrokerUsageStore;
    grant: OwnerModelBrokerGrant;
    gatewayId: string;
    ownerUid: string;
    now: number;
    onBudgetInterruption?: FundedBudgetInterruptionHandler;
    onError?: (error: unknown) => void;
}
export interface RailCharge {
    priceMultiplier: number;
    balanceDebit: BalanceLedgerRef | null;
}
export declare const CHARGE_AT_COST: RailCharge;
export interface RailAllowanceResult {
    countsTowardSpendWindow: boolean;
    charge: RailCharge;
    fundedBudget?: FundedBudget;
}
export interface RailMeterInput {
    grant: OwnerModelBrokerGrant;
    gate: GateDecisionAllowed;
    ownerUid: string | null;
}
export interface RailMeter {
    countsTowardSpendWindow: boolean;
    charge: RailCharge;
}
export interface RailSpendObservation {
    modelAccess: ModelAccess;
    windowCostUsd: number;
    windowBudgetUsd: number;
    weekCostUsd: number;
    weekBudgetUsd: number;
    onOwnerCredential: boolean;
    houseFallback: boolean;
    balanceUsd: number;
    fundedBudget: FundedBudget | null;
    fundedLedger: FundedBudgetLedger | null;
    now: number;
}
export interface RailSpendThrottle extends SpendThrottleState {
    balanceVisible: boolean;
}
export interface ModelBrokerRail {
    readonly id: string;
    requiresGate(grant: OwnerModelBrokerGrant, ownerUid: string | null): boolean;
    gate(ctx: RailGateContext, budgets: SpendBudgets): Promise<DegradeOutcome | null>;
    budgetExhausted(ctx: RailGateContext): Promise<DegradeOutcome>;
    meter(input: RailMeterInput): RailMeter;
    allowance(input: RailAllowanceInput): Promise<RailAllowanceResult>;
    throttle(observation: RailSpendObservation): RailSpendThrottle;
    logFields(grant: OwnerModelBrokerGrant): Record<string, unknown>;
}
export interface ModelBrokerRailRegistry {
    readonly defaultRailId: string;
    readonly railIds: readonly string[];
    rail(id: string): ModelBrokerRail;
    resolveOwnerProfile(ownerData: Record<string, unknown>, ownerUid: string, now: number): OwnerRailProfile | null;
    budgetInspection(budget: FundedBudget | null, ledger: FundedBudgetLedger | null): Record<string, unknown>;
    balanceLedger(ownerUid: string): BalanceLedgerRef | null;
}
export declare class UnknownModelBrokerRailError extends Error {
    readonly railId: string;
    constructor(railId: string);
}
export declare function createModelBrokerRailRegistry(input: {
    rails: readonly ModelBrokerRail[];
    defaultRailId: string;
    resolveOwnerProfile?: ModelBrokerRailRegistry["resolveOwnerProfile"];
    budgetInspection?: ModelBrokerRailRegistry["budgetInspection"];
    balanceLedger?: ModelBrokerRailRegistry["balanceLedger"];
}): ModelBrokerRailRegistry;
export declare function requireSpendWindowAllowance(input: RailAllowanceInput, onExhaustedWithoutHouse: () => Promise<RailAllowanceResult>): Promise<RailAllowanceResult>;
export declare const OPERATOR_RAIL_ID = "operator";
export declare const operatorRail: ModelBrokerRail;
export declare function operatorRailRegistry(): ModelBrokerRailRegistry;
