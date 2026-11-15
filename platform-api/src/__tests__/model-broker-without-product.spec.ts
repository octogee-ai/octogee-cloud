import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createLlmBrokerApp } from "../llm-broker-app.js";
import { operatorRailRegistry } from "../lib/model-broker-rails.js";
import { InMemoryModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import { InMemoryModelBrokerUsageStore } from "../lib/model-broker-usage.js";
import { createWebResearchService } from "../lib/web-research-service.js";

const NOW = 12_000;

describe("model broker with no product rails", () => {
  it("admits and meters operator-rail model traffic at provider cost with no product fields", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const usageStore = new InMemoryModelBrokerUsageStore();
    const log = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      usageStore,
      providerKeys: { anthropic: "sk-ant-platform" },
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ id: "msg_1", model: "claude-sonnet-4-6", usage: { input_tokens: 1_000_000, output_tokens: 0 } }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
      now: () => NOW,
      log,
    });
    const issued = await store.issueToken({
      gatewayId: "jack",
      ownerUid: "uid-jack",
      provider: "anthropic",
      secretName: "gateway-model-key-jack",
      limits: { spendWindowUsd: 10 },
      now: 1_000,
    });

    await request(app).post("/v1/messages").buffer(true).set("x-api-key", issued.token)
      .send({ model: "claude-sonnet-4-6", messages: [] }).expect(200);

    expect(usageStore.events[0]).toMatchObject({ ownerUid: "uid-jack", costUsd: 3, chargeUsd: 3 });
    expect((await usageStore.readWindowUsage({ gatewayId: "jack", ownerUid: "uid-jack", now: NOW })).requestCount).toBe(1);
    const gate = log.mock.calls.find(([message]) => message === "llm-broker gate")?.[1] as Record<string, unknown>;
    expect(gate).toMatchObject({ decision: "forward", rail: "operator" });
    expect(Object.keys(gate).filter((key) => /free|credit/i.test(key))).toEqual([]);
  });

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

  it("keeps no prepaid balance on the usage store", () => {
    const usageStore = new InMemoryModelBrokerUsageStore();
    expect("readCreditBalance" in usageStore).toBe(false);
    expect("creditBalances" in usageStore).toBe(false);
  });
});
