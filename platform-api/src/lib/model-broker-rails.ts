import {
  exhaustedSpendBudget,
  type ModelAccess,
  type SpendThrottleState,
} from "@octogee/shared/types/model-broker-usage";

import type {
  FundedBudget,
  FundedBudgetInterruptionHandler,
  FundedBudgetLedger,
} from "./model-broker-budget.js";
import type { DegradeOutcome, GateDecisionAllowed, RailGateContext, SpendBudgets } from "./model-broker-gate.js";
import type { OwnerModelBrokerGrant } from "./model-broker-limits.js";
import type { BalanceLedgerRef, ModelBrokerUsageStore } from "./model-broker-usage.js";
import { readPlatformSpendState } from "./platform-usage-allowance.js";
import { WebResearchError } from "./web-research-error.js";

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

export const CHARGE_AT_COST: RailCharge = Object.freeze({ priceMultiplier: 1, balanceDebit: null });

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

export class UnknownModelBrokerRailError extends Error {
  constructor(public readonly railId: string) {
    super(`model broker rail is not registered: ${JSON.stringify(railId)}`);
    this.name = "UnknownModelBrokerRailError";
  }
}

export function createModelBrokerRailRegistry(input: {
  rails: readonly ModelBrokerRail[];
  defaultRailId: string;
  resolveOwnerProfile?: ModelBrokerRailRegistry["resolveOwnerProfile"];
  budgetInspection?: ModelBrokerRailRegistry["budgetInspection"];
  balanceLedger?: ModelBrokerRailRegistry["balanceLedger"];
}): ModelBrokerRailRegistry {
  const byId = new Map(input.rails.map((rail) => [rail.id, rail] as const));
  if (byId.size !== input.rails.length) throw new Error("model broker rail ids must be unique");
  if (!byId.has(input.defaultRailId)) {
    throw new Error(`default model broker rail is not registered: ${JSON.stringify(input.defaultRailId)}`);
  }
  return {
    defaultRailId: input.defaultRailId,
    railIds: input.rails.map((rail) => rail.id),
    rail(id) {
      const rail = byId.get(id);
      if (!rail) throw new UnknownModelBrokerRailError(id);
      return rail;
    },
    resolveOwnerProfile: input.resolveOwnerProfile ?? (() => null),
    budgetInspection: input.budgetInspection ?? (() => ({})),
    balanceLedger: input.balanceLedger ?? (() => null),
  };
}

export async function requireSpendWindowAllowance(
  input: RailAllowanceInput,
  onExhaustedWithoutHouse: () => Promise<RailAllowanceResult>,
): Promise<RailAllowanceResult> {
  const state = await readPlatformSpendState({
    usageStore: input.usageStore,
    gatewayId: input.gatewayId,
    ownerUid: input.ownerUid,
    now: input.now,
    spendWindowUsd: input.grant.limits.spendWindowUsd,
    spendWeekUsd: input.grant.limits.spendWeekUsd,
  });
  if (!state.available) {
    throw new WebResearchError("billing_unavailable", 503, "Platform allowance gate unavailable");
  }
  if (state.exhausted) {
    if (input.grant.policy.houseFallback === false) return onExhaustedWithoutHouse();
    throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
  }
  return { countsTowardSpendWindow: true, charge: CHARGE_AT_COST };
}

export const OPERATOR_RAIL_ID = "operator";

const PRODUCT_POLICY_REFUSED: DegradeOutcome = {
  kind: "denied",
  decision: { allowed: false, status: 503, error: "free-tier policy needs a product model broker rail" },
};

export const operatorRail: ModelBrokerRail = {
  id: OPERATOR_RAIL_ID,
  requiresGate: (grant) => grant.policy.freeTier,
  gate: async (ctx) => (ctx.grant.policy.freeTier ? PRODUCT_POLICY_REFUSED : null),
  budgetExhausted: async () => ({
    kind: "denied",
    decision: {
      allowed: false,
      status: 402,
      error: "model budget exhausted for this window and no house model is configured",
    },
  }),
  meter: ({ gate }) => ({ countsTowardSpendWindow: !gate.degrade, charge: CHARGE_AT_COST }),
  allowance: (input) =>
    requireSpendWindowAllowance(input, async () => {
      throw new WebResearchError("allowance_exhausted", 429, "Platform allowance exhausted");
    }),
  throttle: (observation) => {
    const exhausted = observation.onOwnerCredential ? null : exhaustedSpendBudget(observation);
    if (!exhausted) return { degraded: false, blocked: false, reason: null, balanceVisible: false };
    return {
      degraded: observation.houseFallback,
      blocked: !observation.houseFallback,
      reason: `${exhausted}_exhausted`,
      balanceVisible: false,
    };
  },
  logFields: () => ({}),
};

export function operatorRailRegistry(): ModelBrokerRailRegistry {
  return createModelBrokerRailRegistry({ rails: [operatorRail], defaultRailId: OPERATOR_RAIL_ID });
}
