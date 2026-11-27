import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createModelBrokerRailRegistry, operatorRailRegistry } from "@octogee/core/model-broker/rails";
import { InMemoryModelBrokerTokenStore } from "@octogee/core/model-broker/tokens";
import { InMemoryModelBrokerUsageStore } from "@octogee/core/model-broker/usage";
import { createLlmBrokerApp } from "../app.js";

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

  it("logs what each metered request cost, with the rail fields for the decision that served it", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const usageStore = new InMemoryModelBrokerUsageStore();
    const log = vi.fn();
    const operator = operatorRailRegistry().rail("operator");
    const rails = createModelBrokerRailRegistry({
      rails: [{
        ...operator,
        logFields: (_grant, gate) => ({ servedDecision: gate === null ? "none" : gate.degrade ? "degraded" : "forwarded" }),
      }],
      defaultRailId: "operator",
    });
    const app = createLlmBrokerApp({
      rails,
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

    const gate = log.mock.calls.find(([message]) => message === "llm-broker gate")?.[1] as Record<string, unknown>;
    expect(gate).toMatchObject({ decision: "forward", servedDecision: "forwarded" });
    const upstream = log.mock.calls.find(([message]) => message === "llm-broker upstream request")?.[1] as Record<string, unknown>;
    const recorded = log.mock.calls.filter(([message]) => message === "llm-broker usage recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0][1]).toEqual({
      requestId: upstream.requestId,
      gatewayId: "jack",
      ownerUid: "uid-jack",
      provider: "anthropic",
      keySource: "platform",
      rail: "operator",
      servedDecision: "forwarded",
      model: "claude-sonnet-4-6",
      degraded: false,
      totalTokens: 1_000_000,
      costUsd: 3,
      chargeUsd: 3,
      balanceDebited: false,
      countsTowardSpendWindow: true,
    });
  });

  it("keeps no prepaid balance on the usage store", () => {
    const usageStore = new InMemoryModelBrokerUsageStore();
    expect("readCreditBalance" in usageStore).toBe(false);
    expect("creditBalances" in usageStore).toBe(false);
  });
});
