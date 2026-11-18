import {
  MODEL_BROKER_USAGE_WINDOW_MS,
  MODEL_BROKER_WEEK_WINDOW_MS,
  spendWindowPercentUsed,
  usageWindowStartMs,
  weekWindowStartMs,
  type ModelAccess,
  type SpendThrottleState,
} from "@octogee/shared/types/model-broker-usage";

import type { FundedBudgetLedger } from "./budget.js";
import type { ModelBrokerRailRegistry, OwnerRailProfile } from "./rails.js";
import type { ModelBrokerUsageLedger } from "./usage.js";

export const SPEND_ATTENTION_PERCENT = 80;
const UNMETERED_USD = Number.MAX_SAFE_INTEGER;

export interface SpendMeterReading {
  usedUsd: number;
  limitUsd: number;
  percentUsed: number;
  resetsAt: string;
}

export type OwnerSpendMeter =
  | { kind: "owner_credential" }
  | {
      kind: "funded_budget";
      usedUsd: number;
      availableUsd: number;
      hardCapUsd: number;
      percentUsed: number;
      nextIncreaseAt: string | null;
      endsAt: string;
    }
  | { kind: "funded_budget_unavailable" }
  | { kind: "spend_windows"; week: SpendMeterReading; window: SpendMeterReading }
  | { kind: "balance"; balanceUsd: number }
  | { kind: "unmetered" };

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

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

function reading(usedUsd: number, limitUsd: number, resetsAtMs: number): SpendMeterReading {
  return {
    usedUsd: cents(usedUsd),
    limitUsd: cents(limitUsd),
    percentUsed: spendWindowPercentUsed(usedUsd, limitUsd),
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
}

function ownerSpendMeter(input: OwnerSpendObservation): OwnerSpendMeter {
  const { profile } = input;
  if (input.onOwnerCredential) return { kind: "owner_credential" };
  const budget = profile?.fundedBudget ?? null;
  if (budget) {
    if (!input.fundedLedger) return { kind: "funded_budget_unavailable" };
    const availableUsd = Math.min(budget.capUsd, budget.hardCapUsd);
    return {
      kind: "funded_budget",
      usedUsd: cents(input.fundedLedger.chargeUsd),
      availableUsd: cents(availableUsd),
      hardCapUsd: cents(budget.hardCapUsd),
      percentUsed: spendWindowPercentUsed(input.fundedLedger.chargeUsd, availableUsd),
      nextIncreaseAt: budget.nextCapIncreaseAtMs === null ? null : new Date(budget.nextCapIncreaseAtMs).toISOString(),
      endsAt: new Date(budget.expiresAtMs).toISOString(),
    };
  }
  if (profile?.windowBudgets && profile.spendWeekUsd > 0) {
    return {
      kind: "spend_windows",
      week: reading(input.weekCostUsd, profile.spendWeekUsd, weekWindowStartMs(input.now) + MODEL_BROKER_WEEK_WINDOW_MS),
      window: reading(input.windowCostUsd, profile.spendWindowUsd, usageWindowStartMs(input.now) + MODEL_BROKER_USAGE_WINDOW_MS),
    };
  }
  if (input.balanceUsd !== null) return { kind: "balance", balanceUsd: cents(input.balanceUsd) };
  return { kind: "unmetered" };
}

function bindingPercent(meter: OwnerSpendMeter): number {
  if (meter.kind === "funded_budget") return meter.percentUsed;
  if (meter.kind === "spend_windows") return meter.week.percentUsed;
  return 0;
}

export function ownerSpendStanding(
  rails: ModelBrokerRailRegistry,
  input: OwnerSpendObservation,
): OwnerSpendStanding {
  const { profile } = input;
  const rail = profile?.rail ?? rails.defaultRailId;
  const meter = ownerSpendMeter(input);
  const metered = profile?.windowBudgets ? profile : null;
  const { balanceVisible, ...throttle } = rails.rail(rail).throttle({
    modelAccess: input.modelAccess,
    windowCostUsd: input.windowCostUsd,
    windowBudgetUsd: metered?.spendWindowUsd ?? UNMETERED_USD,
    weekCostUsd: input.weekCostUsd,
    weekBudgetUsd: metered?.spendWeekUsd ?? UNMETERED_USD,
    onOwnerCredential: input.onOwnerCredential,
    houseFallback: profile?.houseFallback ?? true,
    balanceUsd: input.balanceUsd ?? 0,
    fundedBudget: profile?.fundedBudget ?? null,
    fundedLedger: input.fundedLedger,
    now: input.now,
  });
  return {
    rail,
    meter,
    balanceUsd: balanceVisible || meter.kind === "balance" ? cents(input.balanceUsd ?? 0) : null,
    throttle,
    needsAttention: throttle.blocked || bindingPercent(meter) >= SPEND_ATTENTION_PERCENT,
  };
}

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

export async function readOwnerSpendStanding(input: OwnerSpendReadInput): Promise<OwnerSpendStanding> {
  const profile = input.rails.resolveOwnerProfile({ ...input.planInputs }, input.ownerUid, input.now);
  const owner = { gatewayId: input.gatewayId, ownerUid: input.ownerUid, now: input.now };
  const balanceLedger = input.rails.balanceLedger(input.ownerUid);
  const budget = profile?.fundedBudget ?? null;
  const [window, week, balanceUsd, fundedLedger] = await Promise.all([
    input.usage.readWindowUsage(owner),
    input.usage.readWeekUsage(owner),
    balanceLedger ? input.usage.readBalance(balanceLedger) : Promise.resolve(null),
    budget ? input.usage.readFundedBudgetLedger(budget) : Promise.resolve(null),
  ]);
  return ownerSpendStanding(input.rails, {
    profile,
    modelAccess: input.modelAccess,
    onOwnerCredential: input.onOwnerCredential,
    windowCostUsd: window.chargeUsd,
    weekCostUsd: week.chargeUsd,
    balanceUsd,
    fundedLedger,
    now: input.now,
  });
}
