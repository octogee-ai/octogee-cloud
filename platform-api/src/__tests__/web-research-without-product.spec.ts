import { describe, expect, it } from "vitest";

import { operatorRailRegistry } from "@octogee/core/model-broker/rails";
import { InMemoryModelBrokerUsageStore } from "@octogee/core/model-broker/usage";
import { createWebResearchService } from "../lib/web-research-service.js";

const NOW = 12_000;

describe("web research with no product rails", () => {
  it("charges operator-rail web research at provider cost", async () => {
    const usageStore = new InMemoryModelBrokerUsageStore();
    const service = createWebResearchService({
      rails: operatorRailRegistry(),
      usageStore,
      resolveGrant: async () => ({
        limits: { spendWindowUsd: 1, spendWeekUsd: null, requestsPerMinute: null },
        policy: { freeTier: false, houseFallback: true },
        rail: "operator",
        fundedBudget: null,
      }),
      braveSearch: async () => ({ provider: "brave" as const, requestId: "br-1", results: [] }),
      now: () => NOW,
      braveCostPerRequestUsd: 0.01,
      tavilyCostPerCreditUsd: 0.008,
    });

    await service.search({ gatewayId: "jack", ownerUid: "uid-jack", agentId: "a", requestId: "r", provider: "brave", query: "q" });

    expect(usageStore.events[0]).toMatchObject({ costUsd: 0.01, chargeUsd: 0.01 });
  });
});
