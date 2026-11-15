import { describe, expect, it } from "vitest";

import { MODEL_BROKER_WEEK_WINDOW_MS } from "@octogee/shared/types/model-broker-usage";
import {
  InMemoryModelBrokerUsageStore,
  estimateAnthropicCost,
  estimateModelBrokerCost,
  isUnknownOpenAiPricingModel,
  isUnknownOpenRouterPricingModel,
  mergeAnthropicUsage,
  modelRollupKey,
  normalizeAnthropicUsage,
  usageWindowStartMs,
  windowOwnerKey,
} from "../lib/model-broker-usage.js";

function ledger(ownerUid: string) {
  return { collection: "balances", ownerUid };
}

const baseRecord = {
  requestId: "req",
  provider: "anthropic" as const,
  gatewayId: "shared-blue",
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
};

describe("model broker usage helpers", () => {
  it("normalizes Anthropic usage and merges streaming cumulative counters", () => {
    const start = normalizeAnthropicUsage({
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    });
    const delta = normalizeAnthropicUsage({ output_tokens: 8 });

    expect(mergeAnthropicUsage(start, delta)).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
    });
  });

  it("estimates current Anthropic per-model costs with cache pricing", () => {
    const cost = estimateAnthropicCost(
      "anthropic/claude-sonnet-4-6",
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      },
      "1h",
    );

    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
    expect(cost.cacheWrite).toBe(6);
    expect(cost.cacheRead).toBeCloseTo(0.3);
    expect(cost.pricingModel).toBe("sonnet");
    expect(cost.cacheWriteTtl).toBe("1h");
    expect(cost.total).toBeCloseTo(24.3);
  });

  it.each([
    ["claude-fable-5-20260618", "fable", 10, 50],
    ["claude-mythos-5-20260618", "mythos", 10, 50],
    ["claude-opus-4-1-20250805", "opus-legacy", 15, 75],
    ["claude-opus-4-5-20260618", "opus-latest", 5, 25],
    ["claude-sonnet-4-6-20260618", "sonnet", 3, 15],
    ["claude-haiku-4-5-20260618", "haiku-4.5", 1, 5],
    ["claude-3-5-haiku-20241022", "haiku-3.5", 0.8, 4],
  ])("routes %s to %s pricing", (model, pricingModel, inputUsd, outputUsd) => {
    const cost = estimateAnthropicCost(model, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost.pricingModel).toBe(pricingModel);
    expect(cost.input).toBe(inputUsd);
    expect(cost.output).toBe(outputUsd);
  });

  it("prices unknown models at a high fallback rate so caps fail closed", () => {
    const cost = estimateAnthropicCost("not-a-real-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost).toMatchObject({
      input: 10,
      output: 50,
      total: 60,
      pricingModel: "unknown-fable-fallback",
    });
  });

  it("prices dated OpenRouter GLM 5.2 responses as the canonical GLM model", () => {
    const cost = estimateModelBrokerCost("openrouter", "z-ai/glm-5.2-20260616", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost.pricingModel).toBe("openrouter:z-ai/glm-5.2");
    expect(isUnknownOpenRouterPricingModel(cost.pricingModel)).toBe(false);
    expect(cost.input).toBeCloseTo(0.6496, 8);
    expect(cost.output).toBeCloseTo(2.0416, 8);
  });

  it("keeps rollup keys and usage windows stable", () => {
    expect(modelRollupKey("anthropic/claude.sonnet 4.6")).toBe(
      "anthropic_claude_sonnet_4_6",
    );
    expect(usageWindowStartMs(4 * 60 * 60 * 1000 + 123)).toBe(4 * 60 * 60 * 1000);
  });

  it("keys the spend counter on the owner, falling back to the gateway", () => {
    expect(windowOwnerKey({ ownerUid: "uid-a", gatewayId: "shared-blue" })).toBe("uid-a");
    expect(windowOwnerKey({ ownerUid: null, gatewayId: "builder-7" })).toBe("builder-7");
  });
});

describe("OpenRouter cost estimation", () => {
  const MILLION_EACH = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1_000_000,
  };

  it("bills OpenRouter cache reads at the discounted rate, not full input price", () => {
    const cost = estimateModelBrokerCost("openrouter", "z-ai/glm-5.2", MILLION_EACH);
    expect(cost.input).toBeCloseTo(0.6496, 8);
    expect(cost.output).toBeCloseTo(2.0416, 8);
    expect(cost.cacheRead).toBeCloseTo(0.12064, 8);
    expect(cost.total).toBeCloseTo(2.81184, 8);
    expect(cost.pricingModel).toBe("openrouter:z-ai/glm-5.2");
  });

  it("prices unknown OpenRouter models at the fallback rate", () => {
    const cost = estimateModelBrokerCost("openrouter", "acme/unknown-1", MILLION_EACH);
    expect(cost.pricingModel).toBe("openrouter:unknown-fallback");
    expect(cost.input).toBe(1);
    expect(cost.output).toBe(5);
    expect(cost.cacheRead).toBeCloseTo(0.1);
  });

  it("prices DeepSeek V4 Pro from the catalog snapshot, not the fallback", () => {
    const cost = estimateModelBrokerCost("openrouter", "deepseek/deepseek-v4-pro", MILLION_EACH);
    expect(cost.pricingModel).toBe("openrouter:deepseek/deepseek-v4-pro");
    expect(cost.input).toBeCloseTo(0.95526, 8);
    expect(cost.output).toBeCloseTo(1.91052, 8);
    expect(cost.cacheRead).toBeCloseTo(0.079605, 8);
  });

  it("estimates GPT-6 Luna from the OpenRouter snapshot with its cache and long-context tiers", () => {
    const usage = { inputTokens: 200_000, cacheReadInputTokens: 70_000, cacheCreationInputTokens: 2_000, outputTokens: 1_000 };
    const short = estimateModelBrokerCost("openrouter", "openai/gpt-6-luna", usage);
    expect(short.pricingModel).toBe("openrouter:openai/gpt-6-luna");
    expect(short.input).toBeCloseTo(0.01, 8);
    expect(short.output).toBeCloseTo(0.00025, 8);
    expect(short.cacheRead).toBeCloseTo(0.00035, 8);
    expect(short.cacheWrite).toBeCloseTo(0.000125, 8);
    const long = estimateModelBrokerCost("openrouter", "openai/gpt-6-luna", { ...usage, inputTokens: 200_001 });
    expect(long.input).toBeCloseTo(0.0200001, 8);
    expect(long.output).toBeCloseTo(0.000375, 8);
    expect(long.cacheRead).toBeCloseTo(0.0007, 8);
    expect(long.cacheWrite).toBeCloseTo(0.00025, 8);
  });

  it("prices GPT-5.6 Luna at OpenRouter's promotional rate", () => {
    const cost = estimateModelBrokerCost("openrouter", "openai/gpt-5.6-luna", { ...MILLION_EACH, inputTokens: 100_000, cacheReadInputTokens: 100_000 });
    expect(cost.pricingModel).toBe("openrouter:openai/gpt-5.6-luna");
    expect(cost.input).toBeCloseTo(0.01);
    expect(cost.output).toBeCloseTo(0.6);
    expect(cost.cacheRead).toBeCloseTo(0.001);
    expect(cost.total).toBeCloseTo(0.611);
  });

  it("applies OpenRouter token-price overrides strictly above their threshold", () => {
    const usage = { inputTokens: 200_000, cacheReadInputTokens: 70_000, cacheCreationInputTokens: 2_000, outputTokens: 1_000 };
    const atThreshold = estimateModelBrokerCost("openrouter", "openai/gpt-5.6-luna", usage);
    expect(atThreshold.output).toBeCloseTo(0.0006, 8);
    const aboveThreshold = estimateModelBrokerCost("openrouter", "openai/gpt-5.6-luna", { ...usage, inputTokens: 200_001 });
    expect(aboveThreshold.output).toBeCloseTo(0.0009, 8);
    expect(aboveThreshold.cacheRead).toBeCloseTo(0.0014, 8);
    expect(aboveThreshold.cacheWrite).toBeCloseTo(0.0005, 8);
  });
});

describe("OpenAI cost estimation", () => {
  it("prices the current Sonnet generation separately from Sonnet 4", () => {
    const cost = estimateModelBrokerCost("anthropic", "claude-sonnet-5", {
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    });
    expect(cost.total).toBe(12);
  });
  it("prices Astra cache writes and the long-context boundary using all input tokens", () => {
    const usage = { inputTokens: 200_000, cacheReadInputTokens: 70_000, cacheCreationInputTokens: 2_000, outputTokens: 1_000 };
    const short = estimateModelBrokerCost("openai", "gpt-6-astra", usage);
    expect(short.pricingModel).toBe("openai:gpt-6-astra");
    expect(short.total).toBeCloseTo(2 + 0.07 + 0.025 + 0.05);
    const long = estimateModelBrokerCost("openai", "gpt-6-astra", { ...usage, inputTokens: 200_001 });
    expect(long.input).toBeCloseTo(4.00002);
    expect(long.output).toBeCloseTo(0.075);
    expect(long.cacheRead).toBeCloseTo(0.14);
    expect(long.cacheWrite).toBeCloseTo(0.05);
  });

  const MILLION_EACH = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1_000_000,
  };

  it.each([
    ["gpt-6-luna", 0.1, 0.01, 0.5],
    ["gpt-6.1-terra", 1, 0.05, 5],
    ["gpt-6.1-sol", 2, 0.1, 10],
  ])("prices %s from the catalog row: $%s in / $%s cached / $%s out per 1M", (model, input, cached, output) => {
    const cost = estimateModelBrokerCost("openai", model, MILLION_EACH);
    expect(cost.pricingModel).toBe(`openai:${model}`);
    expect(isUnknownOpenAiPricingModel(cost.pricingModel)).toBe(false);
    expect(cost.input).toBeCloseTo(input);
    expect(cost.cacheRead).toBeCloseTo(cached);
    expect(cost.output).toBeCloseTo(output);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBeCloseTo(input + cached + output);
  });

  it("prices a dated OpenAI snapshot from its catalog row", () => {
    const cost = estimateModelBrokerCost("openai", "gpt-6.1-terra-2026-10-01", MILLION_EACH);
    expect(cost.pricingModel).toBe("openai:gpt-6.1-terra");
    expect(cost.total).toBeCloseTo(1 + 0.05 + 5);
  });

  it("prices gpt-5.4-mini per the OpenAI table with 10% cached input", () => {
    const cost = estimateModelBrokerCost("openai", "gpt-5.4-mini", MILLION_EACH);
    expect(cost.pricingModel).toBe("openai:gpt-5.4-mini");
    expect(cost.input).toBeCloseTo(0.75);
    expect(cost.output).toBeCloseTo(4.5);
    expect(cost.cacheRead).toBeCloseTo(0.075);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBeCloseTo(5.325);
  });

  it("prices text-embedding-3-small at its input-only embedding rate", () => {
    const cost = estimateModelBrokerCost("openai", "text-embedding-3-small", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cost.pricingModel).toBe("openai:text-embedding-3-small");
    expect(cost.input).toBeCloseTo(0.02);
    expect(cost.output).toBe(0);
    expect(cost.total).toBeCloseTo(0.02);
    expect(isUnknownOpenAiPricingModel(cost.pricingModel)).toBe(false);
  });

  it("prices unknown OpenAI models at the fallback rate and flags them", () => {
    const cost = estimateModelBrokerCost("openai", "gpt-99", MILLION_EACH);
    expect(cost.pricingModel).toBe("openai:unknown-fallback");
    expect(cost.total).toBeGreaterThan(0);
    expect(isUnknownOpenAiPricingModel(cost.pricingModel)).toBe(true);
    expect(isUnknownOpenAiPricingModel("openai:gpt-5.4-mini")).toBe(false);
  });
});

describe("reported upstream cost", () => {
  const openRouterRecord = {
    ...baseRecord,
    provider: "openrouter" as const,
    model: "z-ai/glm-5.2-20260616",
    path: "/v1/chat/completions",
  };

  it("meters the upstream-reported cost, not the table estimate, when present", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...openRouterRecord,
      eventId: "r1",
      ownerUid: "uid-a",
      reportedCostUsd: 0.0123,
    });
    const window = await store.readWindowUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: 10_000,
    });
    expect(window.costUsd).toBeCloseTo(0.0123, 8);
    const event = store.events[0];
    expect(event.costUsd).toBeCloseTo(0.0123, 8);
    expect((event.pricing as Record<string, unknown>).source).toBe("openrouter_reported");
  });

  it("stamps Vertex table cost as provider_reported and attributes it across the Anthropic breakdown", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      provider: "vertex",
      model: "claude-haiku-4-5@20251001",
      usage: { inputTokens: 1_000, outputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      eventId: "v1",
      ownerUid: "uid-a",
      reportedCostUsd: 0.012,
    });
    const event = store.events[0];
    expect(event.costUsd).toBeCloseTo(0.012, 8);
    expect(event.pricing).toMatchObject({ source: "provider_reported", model: "haiku-4.5" });
    const breakdown = event.costBreakdown as Record<string, number>;
    expect(breakdown.output / breakdown.input).toBeCloseTo(5, 8);
  });

  it("scales the cost breakdown so it still sums to the reported total", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...openRouterRecord,
      eventId: "r2",
      ownerUid: "uid-a",
      reportedCostUsd: 0.01,
    });
    const breakdown = store.events[0].costBreakdown as Record<string, number>;
    const sum = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
    expect(sum).toBeCloseTo(0.01, 8);
  });

  it("falls back to the table estimate without a reported cost and marks the source", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...openRouterRecord, eventId: "r3", ownerUid: "uid-a" });
    const event = store.events[0];
    expect((event.pricing as Record<string, unknown>).source).toBe("estimated");
    expect(event.costUsd).toBeGreaterThan(0);
  });
});

describe("platform web usage charges", () => {
  it("stores actual provider cost separately from the marked-up user charge", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "web-brave-1",
      ownerUid: "uid-a",
      provider: "brave",
      model: "brave/web-search",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      reportedCostUsd: 0.005,
      chargeUsd: 0.00625,
      usageKind: "web_search",
      agentId: "octogee-a-coach",
    });

    expect(store.events[0]).toMatchObject({
      provider: "brave",
      costUsd: 0.005,
      chargeUsd: 0.00625,
      usageKind: "web_search",
      agentId: "octogee-a-coach",
    });
    await expect(
      store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-a", now: 10_000 }),
    ).resolves.toMatchObject({ costUsd: 0.005, chargeUsd: 0.00625 });
  });

  it("defaults model charges to actual cost and debits prepaid credit by charge", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.setBalance(ledger("uid-a"), 1);
    await store.recordUsage({
      ...baseRecord,
      eventId: "model-default-charge",
      ownerUid: "uid-a",
    });
    expect(store.events[0].chargeUsd).toBe(store.events[0].costUsd);

    await store.recordUsage({
      ...baseRecord,
      eventId: "web-tavily-1",
      ownerUid: "uid-a",
      provider: "tavily",
      model: "tavily/search-basic",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      reportedCostUsd: 0.008,
      chargeUsd: 0.01,
      balanceDebit: ledger("uid-a"),
      countsTowardSpendWindow: false,
    });
    expect(await store.readBalance(ledger("uid-a"))).toBeCloseTo(0.99);
  });

  it("retains each model provider in the operational rollup", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "provider-rollup-1",
      ownerUid: "uid-a",
      provider: "tavily",
      model: "tavily/search-basic",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      reportedCostUsd: 0.008,
      chargeUsd: 0.01,
    });

    const modelKey = modelRollupKey("tavily/search-basic");
    expect(store.rollups.get("uid-a")?.models[modelKey]).toMatchObject({
      provider: "tavily",
      model: "tavily/search-basic",
      billingModel: "tavily/search-basic",
    });
  });
});

describe("weekly spend ledger", () => {
  it("meters countable traffic into the epoch-aligned week window", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "w1", ownerUid: "uid-a" });
    await store.recordUsage({ ...baseRecord, eventId: "w2", ownerUid: "uid-a" });
    const week = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: 10_000,
    });
    expect(week.weekStartMs).toBe(0);
    expect(week.requestCount).toBe(2);
    expect(week.totalTokens).toBe(300);
    expect(week.costUsd).toBeGreaterThan(0);
  });

  it("starts a fresh ledger at the next epoch week", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "w3", ownerUid: "uid-a" });
    const nextWeek = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-a",
      now: MODEL_BROKER_WEEK_WINDOW_MS + 5,
    });
    expect(nextWeek.weekStartMs).toBe(MODEL_BROKER_WEEK_WINDOW_MS);
    expect(nextWeek.requestCount).toBe(0);
    expect(nextWeek.costUsd).toBe(0);
  });

  it("keeps house/free traffic and other owners out of the weekly ledger", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "w4",
      ownerUid: "uid-free",
      degraded: true,
      countsTowardSpendWindow: false,
    });
    await store.recordUsage({ ...baseRecord, eventId: "w5", ownerUid: "uid-b" });
    const free = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-free",
      now: 10_000,
    });
    const b = await store.readWeekUsage({
      gatewayId: "shared-blue",
      ownerUid: "uid-b",
      now: 10_000,
    });
    expect(free.requestCount).toBe(0);
    expect(b.requestCount).toBe(1);
  });
});

describe("InMemoryModelBrokerUsageStore owner isolation", () => {
  it("never lets one user's spend bleed into another's window on a shared gateway", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({ ...baseRecord, eventId: "a", ownerUid: "uid-a" });
    await store.recordUsage({ ...baseRecord, eventId: "b1", ownerUid: "uid-b" });
    await store.recordUsage({ ...baseRecord, eventId: "b2", ownerUid: "uid-b" });

    const a = await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-a", now: 10_000 });
    const b = await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-b", now: 10_000 });
    expect(a.requestCount).toBe(1);
    expect(b.requestCount).toBe(2);
    expect(b.costUsd).toBeGreaterThan(a.costUsd);
  });

  it("does not count house/free traffic toward the spend window", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "free",
      ownerUid: "uid-free",
      countsTowardSpendWindow: false,
    });
    const w = await store.readWindowUsage({ gatewayId: "shared-blue", ownerUid: "uid-free", now: 10_000 });
    expect(w.costUsd).toBe(0);
    expect(w.requestCount).toBe(0);
  });
});

describe("balance debits", () => {
  it("debits the owner's credit balance atomically with the metering write", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.setBalance(ledger("uid-user"), 10);
    await store.recordUsage({
      ...baseRecord,
      eventId: "c1",
      ownerUid: "uid-user",
      balanceDebit: ledger("uid-user"),
      countsTowardSpendWindow: false,
    });
    const cost = estimateAnthropicCost("claude-sonnet-4-6", baseRecord.usage).total;
    expect(await store.readBalance(ledger("uid-user"))).toBeCloseTo(10 - cost, 8);
    // still fully metered for the ledger
    expect(store.rollups.get("uid-user")?.requestCount).toBe(1);
  });

  it("debits the balance at provider cost times the price multiplier and records that as the charge", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.setBalance(ledger("uid-user"), 10);
    await store.recordUsage({
      ...baseRecord,
      eventId: "m1",
      ownerUid: "uid-user",
      reportedCostUsd: 0.8,
      priceMultiplier: 1.25,
      balanceDebit: ledger("uid-user"),
      countsTowardSpendWindow: false,
    });
    expect(await store.readBalance(ledger("uid-user"))).toBeCloseTo(9, 8);
    expect(store.events[0]).toMatchObject({ costUsd: 0.8, chargeUsd: 1 });
    expect(store.rollups.get("uid-user")).toMatchObject({ costUsd: 0.8, chargeUsd: 1 });
  });

  it("leaves charges at provider cost without a price multiplier", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    await store.recordUsage({
      ...baseRecord,
      eventId: "s-markup",
      ownerUid: "uid-a",
      reportedCostUsd: 0.8,
      countsTowardSpendWindow: true,
    });
    expect(store.events[0]).toMatchObject({ costUsd: 0.8, chargeUsd: 0.8 });
    await expect(
      store.readWeekUsage({ gatewayId: "shared-blue", ownerUid: "uid-a", now: baseRecord.now }),
    ).resolves.toMatchObject({ costUsd: 0.8, chargeUsd: 0.8 });
  });

  it("does not multiply an explicit charge a second time when it debits a balance", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.setBalance(ledger("uid-a"), 1);
    await store.recordUsage({
      ...baseRecord,
      eventId: "web-explicit",
      ownerUid: "uid-a",
      provider: "brave",
      model: "brave/web-search",
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      reportedCostUsd: 0.008,
      chargeUsd: 0.01,
      priceMultiplier: 1.25,
      balanceDebit: ledger("uid-a"),
      countsTowardSpendWindow: false,
    });
    expect(await store.readBalance(ledger("uid-a"))).toBeCloseTo(0.99, 8);
  });

  it.each([0, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses to record a price multiplier of %s",
    async (multiplier) => {
      const store = new InMemoryModelBrokerUsageStore();
      await expect(store.recordUsage({ ...baseRecord, eventId: "bad", priceMultiplier: multiplier }))
        .rejects.toThrow(/price multiplier/);
      expect(store.events).toHaveLength(0);
    },
  );

  it("never debits traffic without a balance debit and defaults unknown owners to zero balance", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.setBalance(ledger("uid-a"), 5);
    await store.recordUsage({ ...baseRecord, eventId: "s1", ownerUid: "uid-a" });
    expect(await store.readBalance(ledger("uid-a"))).toBe(5);
    expect(await store.readBalance(ledger("uid-nobody"))).toBe(0);
  });

  it("allows the final call to overshoot slightly negative — the gate blocks the next one", async () => {
    const store = new InMemoryModelBrokerUsageStore();
    store.setBalance(ledger("uid-user"), 0.0001);
    await store.recordUsage({
      ...baseRecord,
      eventId: "c2",
      ownerUid: "uid-user",
      balanceDebit: ledger("uid-user"),
      countsTowardSpendWindow: false,
    });
    expect(await store.readBalance(ledger("uid-user"))).toBeLessThan(0);
  });
});
