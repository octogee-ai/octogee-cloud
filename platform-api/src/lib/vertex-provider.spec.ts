import { describe, expect, it } from "vitest";

import {
  VertexRequestError,
  computeVertexCost,
  parseVertexModelPrices,
  resolveVertexModel,
  translateVertexMessagesRequest,
  vertexProviderConfigFromEnv,
  vertexUpstreamUrl,
} from "./vertex-provider.js";

const PRICES_JSON = JSON.stringify({
  "claude-haiku-4-5@20251001": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWrite5mPerMTok: 1.25,
    cacheWrite1hPerMTok: 2,
  },
  "claude-sonnet-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWrite5mPerMTok: 2.5,
    cacheWrite1hPerMTok: 4,
  },
});

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    PLATFORM_VERTEX_ENABLED: "true",
    PLATFORM_VERTEX_PROJECT_ID: "octogee-test",
    PLATFORM_VERTEX_MODEL_PRICES: PRICES_JSON,
    ...overrides,
  };
}

describe("vertexProviderConfigFromEnv", () => {
  it("returns null (provider not registered) when the enable flag is unset or false", () => {
    expect(vertexProviderConfigFromEnv({})).toBeNull();
    expect(vertexProviderConfigFromEnv(env({ PLATFORM_VERTEX_ENABLED: "false" }))).toBeNull();
    expect(vertexProviderConfigFromEnv({ PLATFORM_VERTEX_PROJECT_ID: "octogee" })).toBeNull();
  });

  it("defaults the location to global and parses the price table", () => {
    const config = vertexProviderConfigFromEnv(env({}));
    expect(config).toMatchObject({ projectId: "octogee-test", location: "global" });
    expect(Object.keys(config!.prices)).toEqual(["claude-haiku-4-5@20251001", "claude-sonnet-5"]);
    expect(vertexProviderConfigFromEnv(env({ PLATFORM_VERTEX_LOCATION: " us-east5 " }))?.location).toBe("us-east5");
  });

  it("throws at boot when enabled without a project id", () => {
    expect(() => vertexProviderConfigFromEnv(env({ PLATFORM_VERTEX_PROJECT_ID: undefined }))).toThrow(
      /PLATFORM_VERTEX_PROJECT_ID/,
    );
    expect(() => vertexProviderConfigFromEnv(env({ PLATFORM_VERTEX_PROJECT_ID: "  " }))).toThrow(
      /PLATFORM_VERTEX_PROJECT_ID/,
    );
  });

  it("throws at boot when enabled without a parseable price table", () => {
    expect(() => vertexProviderConfigFromEnv(env({ PLATFORM_VERTEX_MODEL_PRICES: undefined }))).toThrow(
      /PLATFORM_VERTEX_MODEL_PRICES/,
    );
    expect(() => vertexProviderConfigFromEnv(env({ PLATFORM_VERTEX_MODEL_PRICES: "{not json" }))).toThrow(
      /PLATFORM_VERTEX_MODEL_PRICES/,
    );
  });
});

describe("parseVertexModelPrices", () => {
  it("rejects entries missing a rate, negative rates, and an empty table", () => {
    expect(() => parseVertexModelPrices({})).toThrow(/at least one model/);
    expect(() =>
      parseVertexModelPrices({ m: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25 } }),
    ).toThrow(/cacheWrite1hPerMTok/);
    expect(() =>
      parseVertexModelPrices({
        m: { inputPerMTok: -1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2 },
      }),
    ).toThrow(/inputPerMTok/);
  });

  it("accepts an optional long-context tier", () => {
    const prices = parseVertexModelPrices({
      m: {
        inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2,
        longContext: { aboveInputTokens: 100_000, inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4 },
      },
    });
    expect(prices.m.longContext?.aboveInputTokens).toBe(100_000);
  });
});

describe("resolveVertexModel", () => {
  it("accepts the catalog id, the bare alias, and the Vertex id, returning the Vertex id", () => {
    expect(resolveVertexModel("vertex/claude-haiku-4-5")).toBe("claude-haiku-4-5@20251001");
    expect(resolveVertexModel("claude-haiku-4-5")).toBe("claude-haiku-4-5@20251001");
    expect(resolveVertexModel("claude-haiku-4-5@20251001")).toBe("claude-haiku-4-5@20251001");
    expect(resolveVertexModel("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("returns null for models the Vertex catalog does not carry", () => {
    expect(resolveVertexModel("gpt-5.4-mini")).toBeNull();
    expect(resolveVertexModel("anthropic/claude-haiku-4-5")).toBeNull();
  });
});

describe("vertexUpstreamUrl", () => {
  const config = { projectId: "octogee", location: "global", prices: {} };

  it("targets the global host and the streaming or unary rawPredict verb", () => {
    expect(vertexUpstreamUrl(config, "claude-sonnet-5", false)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/octogee/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict",
    );
    expect(vertexUpstreamUrl(config, "claude-haiku-4-5@20251001", true)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/octogee/locations/global/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict",
    );
  });

  it("targets the regional host for a named region", () => {
    expect(vertexUpstreamUrl({ ...config, location: "us-east5" }, "claude-sonnet-4-6", true)).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/octogee/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6:streamRawPredict",
    );
  });

  it("honors an explicit base URL override for tests and proxies", () => {
    expect(vertexUpstreamUrl({ ...config, baseUrl: "https://vertex.example/" }, "claude-sonnet-5", false)).toBe(
      "https://vertex.example/v1/projects/octogee/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict",
    );
  });
});

describe("translateVertexMessagesRequest", () => {
  it("moves the model into the path, stamps anthropic_version, and keeps the rest of the body", () => {
    const translated = translateVertexMessagesRequest({
      body: Buffer.from(JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
      })),
      betaHeader: undefined,
    });
    expect(translated.model).toBe("claude-haiku-4-5@20251001");
    expect(translated.stream).toBe(true);
    expect(JSON.parse(translated.body.toString("utf8"))).toEqual({
      anthropic_version: "vertex-2023-10-16",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    });
  });

  it("carries anthropic-beta header values into the body as anthropic_beta", () => {
    const translated = translateVertexMessagesRequest({
      body: Buffer.from(JSON.stringify({ model: "claude-sonnet-5", messages: [] })),
      betaHeader: "context-1m-2025-08-07, prompt-caching-2024-07-31",
    });
    expect(translated.stream).toBe(false);
    expect(JSON.parse(translated.body.toString("utf8")).anthropic_beta).toEqual([
      "context-1m-2025-08-07",
      "prompt-caching-2024-07-31",
    ]);
  });

  it("rejects a non-JSON body, a missing model, and a model Vertex does not serve", () => {
    expect(() => translateVertexMessagesRequest({ body: Buffer.from("nope"), betaHeader: undefined })).toThrow(
      VertexRequestError,
    );
    expect(() =>
      translateVertexMessagesRequest({ body: Buffer.from(JSON.stringify({ messages: [] })), betaHeader: undefined }),
    ).toThrow(/model/);
    expect(() =>
      translateVertexMessagesRequest({
        body: Buffer.from(JSON.stringify({ model: "gpt-5.4-mini", messages: [] })),
        betaHeader: undefined,
      }),
    ).toThrow(/gpt-5.4-mini/);
  });
});

describe("computeVertexCost", () => {
  const prices = parseVertexModelPrices(JSON.parse(PRICES_JSON));

  it("prices input, output, cache reads, and 5m cache writes from the table", () => {
    const cost = computeVertexCost(prices, "claude-haiku-4-5@20251001", {
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheCreationInputTokens: 400_000,
      cacheReadInputTokens: 2_000_000,
    }, "5m");
    expect(cost).toEqual({
      input: 1,
      output: 1,
      cacheRead: 0.2,
      cacheWrite: 0.5,
      total: 2.7,
      pricingModel: "vertex:claude-haiku-4-5@20251001",
    });
  });

  it("prices cache writes at the 1h rate when the request used a 1h breakpoint", () => {
    const cost = computeVertexCost(prices, "claude-sonnet-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 500_000,
      cacheReadInputTokens: 0,
    }, "1h");
    expect(cost.cacheWrite).toBe(2);
    expect(cost.total).toBe(2);
  });

  it("switches to the long-context tier when total input exceeds its threshold", () => {
    const tiered = parseVertexModelPrices({
      m: {
        inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2,
        longContext: { aboveInputTokens: 100_000, inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4 },
      },
    });
    const usage = { inputTokens: 50_000, outputTokens: 10_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 60_000 };
    expect(computeVertexCost(tiered, "m", usage, "5m").total).toBeCloseTo(0.1 + 0.1 + 0.012, 10);
    expect(computeVertexCost(tiered, "m", { ...usage, cacheReadInputTokens: 40_000 }, "5m").total).toBeCloseTo(
      0.05 + 0.05 + 0.004,
      10,
    );
  });

  it("throws instead of pricing an unlisted model at zero", () => {
    expect(() =>
      computeVertexCost(prices, "claude-opus-5", {
        inputTokens: 10, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      }, "5m"),
    ).toThrow(/no price entry.*claude-opus-5/);
  });
});
