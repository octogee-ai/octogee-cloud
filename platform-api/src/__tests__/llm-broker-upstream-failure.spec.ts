import request from "supertest";
import { describe, expect, it, vi, type Mock } from "vitest";

import { createLlmBrokerApp } from "../llm-broker-app.js";
import { operatorRailRegistry } from "../lib/model-broker-rails.js";
import { InMemoryModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import { InMemoryModelBrokerUsageStore } from "../lib/model-broker-usage.js";

const PLATFORM_KEY = "sk-ant-platform-upstream-failure";
const PROMPT = "summarize the quarterly plan for the team";
const UPSTREAM_DURATION_MS = 250;

type BrokerLog = Mock<(msg: string, fields?: Record<string, unknown>) => void>;

async function brokerWith(fetchImpl: (clock: { now: number }) => typeof fetch, options: { upstreamHeaderTimeoutMs?: number } = {}) {
  const clock = { now: 12_000 };
  const store = new InMemoryModelBrokerTokenStore();
  const log: BrokerLog = vi.fn();
  const app = createLlmBrokerApp({
    rails: operatorRailRegistry(),
    store,
    usageStore: new InMemoryModelBrokerUsageStore(),
    providerKeys: { anthropic: PLATFORM_KEY },
    upstreamBaseUrl: "https://anthropic.example",
    fetchImpl: fetchImpl(clock),
    now: () => clock.now,
    log,
    ...options,
  });
  const issued = await store.issueToken({
    gatewayId: "jack",
    ownerUid: "uid-jack",
    provider: "anthropic",
    secretName: "gateway-model-key-jack",
    limits: { spendWindowUsd: 10 },
    now: 1_000,
  });
  const send = () =>
    request(app)
      .post("/v1/messages")
      .buffer(true)
      .set("x-api-key", issued.token)
      .send({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: PROMPT }] });
  return { send, log, token: issued.token };
}

function linesNamed(log: BrokerLog, message: string): Array<Record<string, unknown> | undefined> {
  return log.mock.calls.filter(([msg]) => msg === message).map(([, fields]) => fields);
}

function brokerRequestId(log: BrokerLog): unknown {
  const [request] = linesNamed(log, "llm-broker upstream request");
  return request?.requestId;
}

const UPSTREAM_CALL_FIELDS = {
  gatewayId: "jack",
  ownerUid: "uid-jack",
  provider: "anthropic",
  path: "/v1/messages",
  requestModel: "claude-sonnet-4-6",
};

describe("llm broker upstream failure log", () => {
  it("logs one line with the error class and code when the upstream call throws, without the prompt or keys", async () => {
    const { send, log, token } = await brokerWith((clock) =>
      vi.fn(async (_url: string, init?: RequestInit) => {
        clock.now += UPSTREAM_DURATION_MS;
        throw new TypeError(`fetch failed for ${JSON.stringify(init?.headers)} ${String(init?.body)}`, {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND anthropic.example"), { code: "ENOTFOUND" }),
        });
      }) as unknown as typeof fetch,
    );

    await send().expect(502);

    const failures = linesNamed(log, "llm-broker upstream failed");
    expect(failures).toEqual([
      {
        ...UPSTREAM_CALL_FIELDS,
        requestId: brokerRequestId(log),
        durationMs: UPSTREAM_DURATION_MS,
        errorName: "TypeError",
        errorCode: "ENOTFOUND",
      },
    ]);
    expect(brokerRequestId(log)).toEqual(expect.any(String));
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(PLATFORM_KEY);
    expect(logged).not.toContain(token);
  });

  it("logs one line naming the header timeout when the upstream sends no headers in time", async () => {
    const { send, log } = await brokerWith(
      () =>
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            }),
        ) as unknown as typeof fetch,
      { upstreamHeaderTimeoutMs: 10 },
    );

    await send().expect(504);

    expect(linesNamed(log, "llm-broker upstream failed")).toEqual([
      {
        ...UPSTREAM_CALL_FIELDS,
        requestId: brokerRequestId(log),
        durationMs: 0,
        errorName: "UpstreamHeaderTimeoutError",
        timeoutMs: 10,
      },
    ]);
    expect(linesNamed(log, "llm-broker upstream timeout")).toEqual([]);
  });

  it("logs one line with the upstream status when the provider answers with an error, without the response body", async () => {
    const providerMessage = "Overloaded for organization 4f1e";
    const { send, log } = await brokerWith((clock) =>
      vi.fn(async () => {
        clock.now += UPSTREAM_DURATION_MS;
        return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: providerMessage } }), {
          status: 529,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );

    await send().expect(529);

    expect(linesNamed(log, "llm-broker upstream failed")).toEqual([
      {
        ...UPSTREAM_CALL_FIELDS,
        requestId: brokerRequestId(log),
        durationMs: UPSTREAM_DURATION_MS,
        upstreamStatus: 529,
      },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(providerMessage);
  });

  it("logs no failure line for a successful upstream call", async () => {
    const { send, log } = await brokerWith(() =>
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "msg_1", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 2 } }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );

    await send().expect(200);

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "llm-broker gate",
      "llm-broker upstream request",
      "llm-broker upstream headers",
    ]);
  });
});

describe("llm broker provider refusal log", () => {
  async function openAiRequestWith(deps: Pick<Parameters<typeof createLlmBrokerApp>[0], "providerKeyResolver">) {
    const store = new InMemoryModelBrokerTokenStore();
    const log: BrokerLog = vi.fn();
    const fetchImpl = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store,
      usageStore: new InMemoryModelBrokerUsageStore(),
      providerKeys: { anthropic: PLATFORM_KEY },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 12_000,
      log,
      ...deps,
    });
    const issued = await store.issueToken({
      gatewayId: "jack",
      ownerUid: "uid-jack",
      provider: "openai",
      secretName: "gateway-model-key-jack-openai",
      limits: { spendWindowUsd: 10 },
      now: 1_000,
    });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("authorization", `Bearer ${issued.token}`)
      .send({ model: "gpt-6.1-terra", messages: [{ role: "user", content: PROMPT }] });
    return { response, log, fetchImpl, token: issued.token };
  }

  const REFUSAL_FIELDS = {
    gatewayId: "jack",
    ownerUid: "uid-jack",
    provider: "openai",
    path: "/v1/chat/completions",
    requestModel: "gpt-6.1-terra",
    status: 503,
  };

  it("logs one line with the provider, model and reason when the provider has no key configured", async () => {
    const { response, log, fetchImpl, token } = await openAiRequestWith({});

    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(linesNamed(log, "llm-broker provider refused")).toEqual([
      { ...REFUSAL_FIELDS, reason: "no_key_configured" },
    ]);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(PLATFORM_KEY);
    expect(logged).not.toContain(token);
  });

  it("names a key the broker could not read apart from a key that is not configured", async () => {
    const { response, log } = await openAiRequestWith({
      providerKeyResolver: async () => {
        throw new Error("secret store unreachable");
      },
    });

    expect(response.status).toBe(503);
    expect(linesNamed(log, "llm-broker provider refused")).toEqual([
      { ...REFUSAL_FIELDS, reason: "key_resolution_failed" },
    ]);
  });
});
