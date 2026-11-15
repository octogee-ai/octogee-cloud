import { describe, expect, it } from "vitest";
import type {
  ModelBrokerSpendTotals,
  ModelBrokerUsageLedger,
  ModelBrokerUsageLedgerEntry,
} from "@octogee/core/model-broker-usage-ledger";
import { rateWindowStartMs, usageWindowStartMs, weekWindowStartMs } from "@octogee/shared/types/model-broker-usage";

import { createLedgerModelBrokerUsageStore, usageExpiresAt, type ModelBrokerUsageRecordInput } from "../lib/model-broker-usage.js";

const NOW = 1_800_000_123_456;

function ledgerOf(spend: Record<string, ModelBrokerSpendTotals> = {}) {
  const entries: ModelBrokerUsageLedgerEntry[] = [];
  const reservations: Array<[string, number]> = [];
  const ledger: ModelBrokerUsageLedger = {
    record: async (entry) => {
      entries.push(entry);
      return true;
    },
    readSpend: async (ownerKey, period, startMs) =>
      spend[`${ownerKey}|${period}|${startMs}`] ?? { requestCount: 0, totalTokens: 0, costUsd: 0, chargeUsd: 0 },
    reserveRequest: async (rateKey, startMs) => {
      reservations.push([rateKey, startMs]);
      return reservations.length;
    },
  };
  return { ledger, entries, reservations };
}

function call(overrides: Partial<ModelBrokerUsageRecordInput> = {}): ModelBrokerUsageRecordInput {
  return {
    eventId: "event-1",
    requestId: "request-1",
    provider: "anthropic",
    gatewayId: "shared-1",
    ownerUid: "uid-lin",
    model: "claude-sonnet-4-6",
    usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    method: "POST",
    path: "/v1/messages",
    upstreamStatus: 200,
    now: NOW,
    ...overrides,
  };
}

describe("model broker usage kept in the platform ledger", () => {
  it("records a priced call against the owner's spend window and week", async () => {
    const { ledger, entries } = ledgerOf();

    await createLedgerModelBrokerUsageStore(ledger).recordUsage(call());

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      eventId: "event-1",
      ownerKey: "uid-lin",
      createdAt: NOW,
      expiresAt: usageExpiresAt(NOW).getTime(),
      totalTokens: 1_000_000,
      costUsd: 3,
      chargeUsd: 3,
      spendPeriods: [
        { period: "window", startMs: usageWindowStartMs(NOW) },
        { period: "week", startMs: weekWindowStartMs(NOW) },
      ],
    });
    expect(entries[0].event).toMatchObject({
      gatewayId: "shared-1",
      ownerUid: "uid-lin",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      costUsd: 3,
      chargeUsd: 3,
    });
  });

  it("names an event for a call that arrives without one", async () => {
    const { ledger, entries } = ledgerOf();

    await createLedgerModelBrokerUsageStore(ledger).recordUsage(call({ eventId: undefined }));

    expect(entries[0].eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a call that does not count toward spend out of the spend periods", async () => {
    const { ledger, entries } = ledgerOf();

    await createLedgerModelBrokerUsageStore(ledger).recordUsage(call({ countsTowardSpendWindow: false }));

    expect(entries[0].spendPeriods).toEqual([]);
  });

  it.each([
    ["a balance debit", { balanceDebit: { collection: "balances", ownerUid: "uid-lin" } }],
    ["a funded budget", { fundedBudget: { ledgerKey: "budget-1" } as ModelBrokerUsageRecordInput["fundedBudget"] }],
  ])("refuses %s, which no platform rail keeps", async (_label, overrides) => {
    const { ledger, entries } = ledgerOf();

    await expect(createLedgerModelBrokerUsageStore(ledger).recordUsage(call(overrides))).rejects.toThrow(/platform usage ledger/);
    expect(entries).toEqual([]);
  });

  it("reads the owner's spend for the current window and week", async () => {
    const totals = { requestCount: 2, totalTokens: 40, costUsd: 0.5, chargeUsd: 0.5 };
    const { ledger } = ledgerOf({
      [`uid-lin|window|${usageWindowStartMs(NOW)}`]: totals,
      [`uid-lin|week|${weekWindowStartMs(NOW)}`]: { ...totals, requestCount: 9 },
    });
    const store = createLedgerModelBrokerUsageStore(ledger);

    await expect(store.readWindowUsage({ gatewayId: "shared-1", ownerUid: "uid-lin", now: NOW }))
      .resolves.toEqual({ ownerKey: "uid-lin", windowStartMs: usageWindowStartMs(NOW), ...totals });
    await expect(store.readWeekUsage({ gatewayId: "shared-1", ownerUid: "uid-lin", now: NOW }))
      .resolves.toEqual({ ownerKey: "uid-lin", weekStartMs: weekWindowStartMs(NOW), ...totals, requestCount: 9 });
  });

  it("reserves the rate window for each owner and scope", async () => {
    const { ledger, reservations } = ledgerOf();
    const store = createLedgerModelBrokerUsageStore(ledger);

    await expect(store.reserveRateWindow({ gatewayId: "shared-1", ownerUid: "uid-lin", scope: "embedding", now: NOW }))
      .resolves.toEqual({ ownerKey: "uid-lin:embedding", windowStartMs: rateWindowStartMs(NOW), requestCount: 1 });
    expect(reservations).toEqual([["uid-lin:embedding", rateWindowStartMs(NOW)]]);
  });
});
