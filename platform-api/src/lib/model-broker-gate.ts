import type { FundedBudgetInterruption } from "./model-broker-budget.js";
import type { OwnerModelBrokerGrant } from "./model-broker-limits.js";
import type { ModelBrokerUsageStore } from "./model-broker-usage.js";
import { readPlatformSpendState } from "./platform-usage-allowance.js";

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

export type DegradeOutcome =
  | { kind: "denied"; decision: GateDecision }
  | {
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

export async function spendWindowGate(
  ctx: RailGateContext,
  spendWindowUsd: number | null,
  spendWeekUsd: number | null,
): Promise<
  { degrade: boolean; windowCostUsd: number | null; weekCostUsd: number | null } | GateDecisionDenied
> {
  const state = await readPlatformSpendState({
    usageStore: ctx.usageStore,
    gatewayId: ctx.gatewayId,
    ownerUid: ctx.ownerUid,
    now: ctx.now(),
    spendWindowUsd,
    spendWeekUsd,
  });
  if (!state.available) {
    return { allowed: false, status: 503, error: "model broker spend gate unavailable" };
  }
  return {
    degrade: state.exhausted,
    windowCostUsd: state.windowChargeUsd,
    weekCostUsd: state.weekChargeUsd,
  };
}
