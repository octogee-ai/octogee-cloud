import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createLlmBrokerApp, type LlmBrokerAppDeps } from "../llm-broker-app.js";
import { InMemoryModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import { InMemoryModelBrokerUsageStore } from "../lib/model-broker-usage.js";
import { parseVertexModelPrices } from "../lib/vertex-provider.js";
import { operatorRailRegistry } from "../lib/model-broker-rails.js";

const PRICES = parseVertexModelPrices({
  "claude-haiku-4-5@20251001": {
    inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2,
  },
  "claude-sonnet-5": {
    inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWrite5mPerMTok: 2.5, cacheWrite1hPerMTok: 4,
  },
});

function vertexDeps(overrides: Partial<NonNullable<LlmBrokerAppDeps["vertex"]>> = {}): NonNullable<LlmBrokerAppDeps["vertex"]> {
  return {
    projectId: "octogee-test",
    location: "global",
    prices: PRICES,
    accessToken: vi.fn(async () => "ya29.adc-token"),
    ...overrides,
  };
}

async function vertexToken(store: InMemoryModelBrokerTokenStore, spendWindowUsd: number | null = null): Promise<string> {
  const issued = await store.issueToken({
    gatewayId: "jack",
    ownerUid: "uid-jack",
    provider: "vertex",
    secretName: "agent-model-token-vertex-jack",
    limits: { spendWindowUsd },
    now: 1_000,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  return issued.token;
}

function jsonUpstream(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("llm broker vertex rail", () => {
  it("reports the rail unregistered and refuses vertex tokens when no vertex config is supplied", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const fetchMock = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      providerKeys: { anthropic: "sk-ant-platform" },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const token = await vertexToken(store);

    const health = await request(app).get("/healthz").expect(200);
    expect(health.body.providers).toMatchObject({ anthropic: true, vertex: false });
    const res = await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .send({ model: "claude-sonnet-5", messages: [] })
      .expect(503);
    expect(res.body).toEqual({ error: "vertex upstream is not configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers the rail from config and lists its catalog without an upstream call", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const vertex = vertexDeps();
    const app = createLlmBrokerApp({ rails: operatorRailRegistry(), store, providerKeys: {}, vertex });
    const token = await vertexToken(store);

    const health = await request(app).get("/healthz").expect(200);
    expect(health.body.providers).toMatchObject({ anthropic: false, vertex: true });
    const catalog = await request(app).get("/v1/catalog").set("x-api-key", token).expect(200);
    expect(catalog.body.provider).toBe("vertex");
    expect(catalog.body.routes).toEqual([{ method: "POST", path: "/v1/messages" }]);
    expect(catalog.body.models.map((m: { id: string }) => m.id)).toContain("vertex/claude-sonnet-5");
    expect(vertex.accessToken).not.toHaveBeenCalled();
  });

  it("translates a Messages call onto the Vertex endpoint with an ADC bearer and meters table cost", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const usageStore = new InMemoryModelBrokerUsageStore();
    const fetchMock = vi.fn(async () => jsonUpstream({
      id: "msg_vertex_1",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 200_000,
        cache_read_input_tokens: 500_000,
      },
    }));
    const vertex = vertexDeps();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      usageStore,
      providerKeys: {},
      vertex,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 10_000,
    });
    const token = await vertexToken(store);

    await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .set("anthropic-version", "2023-06-01")
      .set("anthropic-beta", "context-1m-2025-08-07")
      .send({ model: "vertex/claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] })
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/octogee-test/locations/global/publishers/anthropic/models/claude-sonnet-5:rawPredict",
    );
    expect(init.headers).toMatchObject({
      authorization: "Bearer ya29.adc-token",
      "content-type": "application/json",
    });
    expect(init.headers).not.toHaveProperty("anthropic-beta");
    expect(init.headers).not.toHaveProperty("anthropic-version");
    expect(init.headers).not.toHaveProperty("x-api-key");
    expect(JSON.parse(init.body as string)).toEqual({
      anthropic_version: "vertex-2023-10-16",
      anthropic_beta: ["context-1m-2025-08-07"],
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(usageStore.events).toHaveLength(1);
    expect(usageStore.events[0]).toMatchObject({
      upstreamId: "msg_vertex_1",
      provider: "vertex",
      gatewayId: "jack",
      ownerUid: "uid-jack",
      providerKeySource: "platform",
      model: "claude-sonnet-5",
      path: "/v1/messages",
      totalTokens: 1_800_000,
      costUsd: 2 + 1 + 0.1 + 0.5,
      pricing: { source: "provider_reported" },
      countsTowardSpendWindow: true,
    });
  });

  it("streams through streamRawPredict and prices the teed SSE usage, 1h cache writes included", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const usageStore = new InMemoryModelBrokerUsageStore();
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":100000,"output_tokens":0,"cache_creation_input_tokens":400000,"cache_read_input_tokens":0}}}\n\n',
            ));
            controller.enqueue(encoder.encode(
              'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":200000}}\n\n',
            ));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      usageStore,
      providerKeys: {},
      vertex: vertexDeps(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 10_000,
    });
    const token = await vertexToken(store);

    const res = await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .send({
        model: "claude-haiku-4-5",
        stream: true,
        system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [],
      })
      .expect(200);

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"type":"message_delta"');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toMatch(/models\/claude-haiku-4-5@20251001:streamRawPredict$/);
    expect(usageStore.events).toHaveLength(1);
    expect(usageStore.events[0]).toMatchObject({
      model: "claude-haiku-4-5@20251001",
      usage: { inputTokens: 100_000, outputTokens: 200_000, cacheCreationInputTokens: 400_000 },
      costUsd: 0.1 + 1 + 0.8,
      pricing: { cacheWriteTtl: "1h", source: "provider_reported" },
    });
  });

  it("refuses a catalog model with no price entry before any upstream call", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const fetchMock = vi.fn();
    const onMeteringError = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      providerKeys: {},
      vertex: vertexDeps(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      onMeteringError,
    });
    const token = await vertexToken(store);

    const res = await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .send({ model: "claude-opus-5", messages: [] })
      .expect(503);
    expect(res.body.error).toMatch(/no price entry.*claude-opus-5/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onMeteringError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/claude-opus-5/) }));
  });

  it("rejects models Vertex does not serve and non-Messages paths", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const fetchMock = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      providerKeys: {},
      vertex: vertexDeps(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const token = await vertexToken(store);

    const unsupported = await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .send({ model: "gpt-5.4-mini", messages: [] })
      .expect(400);
    expect(unsupported.body.error).toMatch(/gpt-5.4-mini/);
    await request(app).get("/v1/models").set("x-api-key", token).expect(404);
    await request(app)
      .post("/v1/chat/completions")
      .buffer(true)
      .set("x-api-key", token)
      .send({ model: "claude-sonnet-5", messages: [] })
      .expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades an exhausted window onto the Vertex house model", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const usageStore = new InMemoryModelBrokerUsageStore();
    await usageStore.recordUsage({
      eventId: "seed",
      requestId: "seed",
      provider: "vertex",
      gatewayId: "jack",
      ownerUid: "uid-jack",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      reportedCostUsd: 2,
      method: "POST",
      path: "/v1/messages",
      upstreamStatus: 200,
      now: 12_000,
    });
    const fetchMock = vi.fn(async () => jsonUpstream({
      id: "msg_degraded",
      model: "claude-haiku-4-5",
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      usageStore,
      providerKeys: {},
      vertex: vertexDeps(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => 12_000,
    });
    const token = await vertexToken(store, 1);

    await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .send({ model: "claude-sonnet-5", messages: [] })
      .expect(200);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toMatch(/models\/claude-haiku-4-5@20251001:rawPredict$/);
    expect(usageStore.events.find((e) => e.upstreamId === "msg_degraded")).toMatchObject({
      degraded: true,
      countsTowardSpendWindow: false,
      model: "claude-haiku-4-5@20251001",
    });
  });

  it("fails closed when the ADC access token cannot be minted", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const fetchMock = vi.fn();
    const onMeteringError = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      providerKeys: {},
      vertex: vertexDeps({ accessToken: vi.fn(async () => { throw new Error("metadata server unreachable"); }) }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      onMeteringError,
    });
    const token = await vertexToken(store);

    await request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", token)
      .send({ model: "claude-sonnet-5", messages: [] })
      .expect(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onMeteringError).toHaveBeenCalledWith(expect.objectContaining({ message: "metadata server unreachable" }));
  });
});
