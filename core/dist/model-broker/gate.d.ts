import type { FundedBudgetInterruption } from "./budget.js";
import type { OwnerModelBrokerGrant } from "./limits.js";
import type { ModelBrokerUsageStore } from "./usage.js";
export interface GateDecisionAllowed {
    allowed: true;
    degrade: boolean;
    degradeReason: string | null;
    houseModelDial: boolean;
    decision: string | null;
    windowCostUsd: number | null;
    weekCostUsd: number | null;
    balanceUsd: number | null;
    budgetFunded: boolean;
    budgetChargeUsd: number | null;
}
export interface GateDecisionDenied {
    allowed: false;
    status: 402 | 429 | 503;
    error: string;
    retryAfterSeconds?: number;
    budgetInterruption?: FundedBudgetInterruption;
    budgetChargeUsd?: number;
}
export type GateDecision = GateDecisionAllowed | GateDecisionDenied;
export type DegradeOutcome = {
    kind: "denied";
    decision: GateDecision;
} | {
    kind: "state";
    degrade: boolean;
    degradeReason: GateDecisionAllowed["degradeReason"];
    houseModelDial?: boolean;
    decision?: string;
    windowCostUsd: number | null;
    weekCostUsd: number | null;
    balanceUsd: number | null;
    budgetFunded?: boolean;
    budgetChargeUsd?: number | null;
};
export interface RailGateContext {
    grant: OwnerModelBrokerGrant;
    gatewayId: string;
    ownerUid: string | null;
    usageStore?: ModelBrokerUsageStore;
    now: () => number;
}
export interface SpendBudgets {
    spendWindowUsd: number | null;
    spendWeekUsd: number | null;
}
export declare function spendWindowGate(ctx: RailGateContext, spendWindowUsd: number | null, spendWeekUsd: number | null): Promise<{
    degrade: boolean;
    windowCostUsd: number | null;
    weekCostUsd: number | null;
} | GateDecisionDenied>;
