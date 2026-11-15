import { describe, expect, it } from "vitest";

import {
  fundedBudgetStanding,
  parseFundedBudgetLedger,
  type FundedBudget,
  type FundedBudgetLedger,
} from "../lib/model-broker-budget.js";
import { InMemoryModelBrokerUsageStore } from "../lib/model-broker-usage.js";

const budget: FundedBudget = {
  ownerUid: "uid-a",
  ledgerCollection: "fundedBudgets",
  ledgerKey: "budget-1",
  ledgerBinding: { grantId: "grant-1", revision: 2 },
  ledgerRetentionMs: 60_000,
  expiresAtMs: 100_000,
  capUsd: 5,
  hardCapUsd: 8,
  nextCapIncreaseAtMs: 50_000,
  logFields: {},
};

const storedLedger = {
  ownerUid: "uid-a",
  grantId: "grant-1",
  revision: 2,
  chargeUsd: 1,
  requestCount: 1,
  totalTokens: 10,
  updatedAt: 1_000,
};

function ledgerAt(chargeUsd: number): FundedBudgetLedger {
  return { chargeUsd, requestCount: 1, totalTokens: 10, updatedAt: 1_000 };
}

describe("parseFundedBudgetLedger", () => {
  it("reads a ledger bound to the owner and every binding field", () => {
    expect(parseFundedBudgetLedger(storedLedger, budget)).toEqual({
      chargeUsd: 1,
      requestCount: 1,
      totalTokens: 10,
      updatedAt: 1_000,
    });
  });

  it.each([
    ["another owner", { ownerUid: "uid-b" }],
    ["another binding value", { grantId: "grant-2" }],
    ["a binding value of another type", { revision: "2" }],
    ["a missing binding field", { grantId: undefined }],
    ["a negative charge", { chargeUsd: -0.01 }],
    ["an infinite charge", { chargeUsd: Number.POSITIVE_INFINITY }],
    ["a fractional request count", { requestCount: 1.5 }],
    ["a non-numeric token count", { totalTokens: "10" }],
    ["a missing update time", { updatedAt: undefined }],
  ])("rejects a ledger with %s", (_label, overrides) => {
    expect(parseFundedBudgetLedger({ ...storedLedger, ...overrides }, budget)).toBeNull();
  });

  it.each([[null], [undefined], ["ledger"], [[storedLedger]]])("rejects the non-record %j", (value) => {
    expect(parseFundedBudgetLedger(value, budget)).toBeNull();
  });
});

describe("fundedBudgetStanding", () => {
  it("is funded below the cap", () => {
    expect(fundedBudgetStanding(budget, ledgerAt(4.99), 10_000)).toEqual({ state: "funded" });
  });

  it("awaits the next increase at the cap", () => {
    expect(fundedBudgetStanding(budget, ledgerAt(5), 10_000)).toEqual({
      state: "awaiting_increase",
      increaseAtMs: 50_000,
    });
  });

  it("is exhausted at the hard cap even with an increase scheduled", () => {
    expect(fundedBudgetStanding(budget, ledgerAt(8), 10_000)).toEqual({ state: "exhausted" });
  });

  it("is exhausted at the cap when no increase is scheduled", () => {
    expect(fundedBudgetStanding({ ...budget, nextCapIncreaseAtMs: null }, ledgerAt(5), 10_000)).toEqual({
      state: "exhausted",
    });
  });

  it("holds spending to a hard cap set below the cap", () => {
    expect(fundedBudgetStanding({ ...budget, hardCapUsd: 3 }, ledgerAt(3), 10_000)).toEqual({ state: "exhausted" });
    expect(fundedBudgetStanding({ ...budget, hardCapUsd: 3 }, ledgerAt(2.99), 10_000)).toEqual({ state: "funded" });
  });

  it("is funded until the millisecond before expiry and exhausted from expiry on", () => {
    expect(fundedBudgetStanding(budget, ledgerAt(0), 99_999)).toEqual({ state: "funded" });
    expect(fundedBudgetStanding(budget, ledgerAt(0), 100_000)).toEqual({ state: "exhausted" });
    expect(fundedBudgetStanding(budget, ledgerAt(0), 100_001)).toEqual({ state: "exhausted" });
  });
});

describe("funded budget accounting", () => {
  const record = {
    requestId: "req",
    provider: "anthropic" as const,
    gatewayId: "shared-blue",
    ownerUid: "uid-a",
    model: "claude-sonnet-4-6",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    method: "POST",
    path: "/v1/messages",
    upstreamStatus: 200,
    now: 10_000,
    reportedCostUsd: 0.1,
    countsTowardSpendWindow: false,
    fundedBudget: budget,
  };

  function storeWithLedger(chargeUsd = 0): InMemoryModelBrokerUsageStore {
    const store = new InMemoryModelBrokerUsageStore();
    store.fundedBudgetLedgers.set(budget.ledgerKey, { ...storedLedger, chargeUsd, requestCount: 0, totalTokens: 0 });
    return store;
  }

  it("adds every concurrent charge to the ledger exactly once", async () => {
    const store = storeWithLedger();

    await Promise.all(Array.from({ length: 25 }, (_, index) => store.recordUsage({ ...record, eventId: `evt-${index}` })));
    await store.recordUsage({ ...record, eventId: "evt-0" });

    const ledger = await store.readFundedBudgetLedger(budget);
    expect(ledger?.requestCount).toBe(25);
    expect(ledger?.totalTokens).toBe(25 * 150);
    expect(ledger?.chargeUsd).toBeCloseTo(2.5, 8);
  });

  it("keeps a funded charge out of the spend window", async () => {
    const store = storeWithLedger();

    await store.recordUsage({ ...record, eventId: "evt-window" });

    expect((await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-a", now: 10_000 })).requestCount).toBe(0);
    expect(store.events[0]).toMatchObject({ fundedBudgetKey: budget.ledgerKey });
  });

  it("records nothing when the ledger is missing or bound to another owner", async () => {
    const missing = new InMemoryModelBrokerUsageStore();
    await expect(missing.recordUsage({ ...record, eventId: "evt-missing" })).rejects.toThrow(/ledger missing/);
    expect(missing.events).toHaveLength(0);

    const foreign = new InMemoryModelBrokerUsageStore();
    foreign.fundedBudgetLedgers.set(budget.ledgerKey, { ...storedLedger, ownerUid: "uid-b" });
    await expect(foreign.recordUsage({ ...record, eventId: "evt-foreign" })).rejects.toThrow(/ledger missing/);
    expect(foreign.events).toHaveLength(0);
    expect(await foreign.readFundedBudgetLedger(budget)).toBeNull();
  });
});
