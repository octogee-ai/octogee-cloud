import { describe, expect, it } from "vitest";

import type { FundedBudget } from "./budget.js";
import {
  createModelBrokerRailRegistry,
  operatorRail,
  operatorRailRegistry,
  type ModelBrokerRail,
  type OwnerRailProfile,
  type RailSpendObservation,
} from "./rails.js";
import { ownerSpendStanding, unavailableSpendStanding, type OwnerSpendObservation } from "./owner-spend-standing.js";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const budget: FundedBudget = {
  ownerUid: "u1",
  ledgerCollection: "fundedBudgets",
  ledgerKey: "u1_budget",
  ledgerBinding: { budgetId: "budget-1" },
  ledgerRetentionMs: 0,
  expiresAtMs: NOW + 6 * 86_400_000,
  capUsd: 4.8,
  hardCapUsd: 8,
  nextCapIncreaseAtMs: NOW + 3_600_000,
  logFields: {},
};

function profile(overrides: Partial<OwnerRailProfile> = {}): OwnerRailProfile {
  return {
    rail: "metered",
    spendWindowUsd: 1.5,
    spendWeekUsd: 21,
    windowBudgets: true,
    freeTier: false,
    houseFallback: true,
    fundedBudget: null,
    ...overrides,
  };
}

function observation(overrides: Partial<OwnerSpendObservation> = {}): OwnerSpendObservation {
  return {
    profile: profile(),
    modelAccess: "catalog",
    onOwnerCredential: false,
    windowCostUsd: 0,
    weekCostUsd: 0,
    balanceUsd: null,
    fundedLedger: null,
    now: NOW,
    ...overrides,
  };
}

function recordingRegistry(throttle: ModelBrokerRail["throttle"] = operatorRail.throttle) {
  const seen: RailSpendObservation[] = [];
  const rail: ModelBrokerRail = {
    ...operatorRail,
    id: "metered",
    throttle: (input) => {
      seen.push(input);
      return throttle(input);
    },
  };
  return { seen, rails: createModelBrokerRailRegistry({ rails: [rail], defaultRailId: "metered" }) };
}

describe("ownerSpendStanding", () => {
  it("reads a funded budget against what is unlocked now and hands the ledger to the rail's throttle", () => {
    const { seen, rails } = recordingRegistry();
    const fundedLedger = { chargeUsd: 4.81, requestCount: 402, totalTokens: 27_565_342, updatedAt: NOW };
    const standing = ownerSpendStanding(rails, observation({
      profile: profile({ windowBudgets: false, fundedBudget: budget }),
      fundedLedger,
    }));

    expect(standing.meter).toEqual({
      kind: "funded_budget",
      usedUsd: 4.81,
      availableUsd: 4.8,
      hardCapUsd: 8,
      percentUsed: 100,
      nextIncreaseAt: new Date(NOW + 3_600_000).toISOString(),
      endsAt: new Date(NOW + 6 * 86_400_000).toISOString(),
    });
    expect(standing.needsAttention).toBe(true);
    expect(seen[0]).toMatchObject({ fundedBudget: budget, fundedLedger, now: NOW });
  });

  it("reports a funded budget whose ledger cannot be read instead of a zero meter", () => {
    const { rails } = recordingRegistry();
    const standing = ownerSpendStanding(rails, observation({
      profile: profile({ windowBudgets: false, fundedBudget: budget }),
    }));
    expect(standing.meter).toEqual({ kind: "funded_budget_unavailable" });
  });

  it("reads the week and the burst window for a plan with spend windows", () => {
    const { rails } = recordingRegistry();
    const standing = ownerSpendStanding(rails, observation({ weekCostUsd: 10.5, windowCostUsd: 1.5 }));

    expect(standing.meter).toEqual({
      kind: "spend_windows",
      week: { usedUsd: 10.5, limitUsd: 21, percentUsed: 50, resetsAt: "2026-11-19T00:00:00.000Z" },
      window: { usedUsd: 1.5, limitUsd: 1.5, percentUsed: 100, resetsAt: "2026-11-18T16:00:00.000Z" },
    });
    expect(standing.throttle).toEqual({ degraded: true, blocked: false, reason: "window_exhausted" });
    expect(standing.needsAttention).toBe(false);
  });

  it("flags a week that is mostly spent", () => {
    const { rails } = recordingRegistry();
    expect(ownerSpendStanding(rails, observation({ weekCostUsd: 17 })).needsAttention).toBe(true);
  });

  it("flags a blocked owner even when no meter is near its limit", () => {
    const { rails } = recordingRegistry(() => ({ degraded: false, blocked: true, reason: "balance_exhausted", balanceVisible: true }));
    const standing = ownerSpendStanding(rails, observation({
      profile: profile({ windowBudgets: false }),
      balanceUsd: 0,
    }));
    expect(standing.meter).toEqual({ kind: "balance", balanceUsd: 0 });
    expect(standing.balanceUsd).toBe(0);
    expect(standing.needsAttention).toBe(true);
  });

  it("treats an owner with no budget as unmetered rather than 100% used", () => {
    const standing = ownerSpendStanding(operatorRailRegistry(), observation({ profile: null }));
    expect(standing.meter).toEqual({ kind: "unmetered" });
    expect(standing.throttle).toEqual({ degraded: false, blocked: false, reason: null });
    expect(standing.needsAttention).toBe(false);
  });

  it("shows no platform meter while the owner's own credential pays", () => {
    const { rails } = recordingRegistry();
    const standing = ownerSpendStanding(rails, observation({ onOwnerCredential: true, weekCostUsd: 30 }));
    expect(standing.meter).toEqual({ kind: "owner_credential" });
    expect(standing.needsAttention).toBe(false);
  });
});

describe("unavailableSpendStanding", () => {
  it("flags a failed read but not a platform that has no usage ledger", () => {
    expect(unavailableSpendStanding("metered", "read_failed")).toEqual({
      rail: "metered",
      meter: { kind: "unavailable", cause: "read_failed" },
      balanceUsd: null,
      throttle: { degraded: false, blocked: false, reason: null },
      needsAttention: true,
    });
    expect(unavailableSpendStanding("operator", "no_usage_ledger").needsAttention).toBe(false);
  });
});
