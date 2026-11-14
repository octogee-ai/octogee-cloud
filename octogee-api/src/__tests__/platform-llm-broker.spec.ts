import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { SecretNotFoundError } from "@octogee/core/secret-store";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { noUserAccounts, userAccountFromData, type UserAccountReader } from "@octogee/core/user-account";

import { createModelBrokerTokenStore } from "../lib/model-broker-tokens.js";
import { InMemoryModelBrokerUsageStore } from "../lib/model-broker-usage.js";
import { createPlatformLlmBrokerApp, type PlatformLlmBrokerSources } from "../platform-llm-broker.js";

const NOW = 1_800_000_000_000;
const ENTITLEMENTS = Symbol.for("octogee.userEntitlements");

const platformAccounts: UserAccountReader = {
  get: async (uid) => userAccountFromData(uid, { username: "lin" }),
  getMany: async (uids) => new Map(uids.map((uid) => [uid, userAccountFromData(uid, { username: "lin" })])),
  list: async () => new Map(),
};

function gatewayRoot(gatewayId: string, gatewayClass: "shared" | "isolated"): Record<string, unknown> {
  const isolated = gatewayClass === "isolated";
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: isolated ? "isolated" : null, gatewayClass,
    imageProfile: isolated ? "isolated" : "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: isolated ? "uid-lin" : null,
    builderSlug: isolated ? "lin" : null,
    modelBrokerLimits: null, preemption: null,
  };
}

function platform(gatewayId: "shared-1" | "lin") {
  return createDocumentFixtureStore({
    "gateways/shared-1": gatewayRoot("shared-1", "shared"),
    "gateways/lin": gatewayRoot("lin", "isolated"),
    "users/uid-lin": { username: "lin", provisioning: { openclaw: { gatewayId } } },
  });
}

function upstream() {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ id: "msg_1", model: "claude-sonnet-4-6", usage: { input_tokens: 1_000, output_tokens: 10 } }), {
      headers: { "content-type": "application/json" },
    }));
}

async function broker(input: {
  gatewayId: "shared-1" | "lin";
  readSecret?: PlatformLlmBrokerSources["readSecret"];
  env?: PlatformLlmBrokerSources["env"];
  accounts?: UserAccountReader;
}) {
  const state = platform(input.gatewayId);
  const usageStore = new InMemoryModelBrokerUsageStore();
  const fetchImpl = upstream();
  const errors: unknown[] = [];
  const app = createPlatformLlmBrokerApp({
    env: input.env ?? { ANTHROPIC_API_KEY: "operator-anthropic-key" },
    state,
    accounts: input.accounts ?? noUserAccounts,
    usageStore,
    readSecret: input.readSecret ?? (async (name) => { throw new SecretNotFoundError(name); }),
    logger: { info: () => undefined, error: (_message, fields) => errors.push(fields?.err) },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });
  const issued = await createModelBrokerTokenStore(state).issueToken({
    gatewayId: input.gatewayId,
    ownerUid: "uid-lin",
    provider: "anthropic",
    secretName: `agent-model-token-${input.gatewayId}-uid-lin`,
    skipPointer: true,
    ttlSeconds: 3_600,
    now: NOW,
    limits: { spendWindowUsd: 5, spendWeekUsd: null, requestsPerMinute: null },
    policy: { freeTier: false, houseFallback: true },
  });
  const send = () => request(app).post("/v1/messages").buffer(true).set("x-api-key", issued.token)
    .send({ model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  const upstreamKey = () => new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-api-key");
  return { app, send, fetchImpl, upstreamKey, usageStore, errors };
}

describe("the platform LLM broker", () => {
  it("answers a shared gateway agent with the operator's provider key and meters the call", async () => {
    const { send, upstreamKey, usageStore } = await broker({ gatewayId: "shared-1" });

    await send().expect(200);

    expect(upstreamKey()).toBe("operator-anthropic-key");
    expect(usageStore.events).toHaveLength(1);
    expect(usageStore.events[0]).toMatchObject({
      gatewayId: "shared-1",
      ownerUid: "uid-lin",
      provider: "anthropic",
      providerKeySource: "platform",
    });
    expect((await usageStore.readWindowUsage({ gatewayId: "shared-1", ownerUid: "uid-lin", now: NOW })).requestCount).toBe(1);
  });

  it("uses an isolated gateway owner's key from the secret store", async () => {
    const readSecret = vi.fn(async (name: string) => {
      if (name === "byok-lin-anthropic") return "owner-anthropic-key";
      throw new SecretNotFoundError(name);
    });
    const { send, upstreamKey, usageStore } = await broker({ gatewayId: "lin", readSecret });

    await send().expect(200);

    expect(upstreamKey()).toBe("owner-anthropic-key");
    expect(usageStore.events[0]).toMatchObject({
      providerKeySource: "owner_model_credential",
      providerKeySecretName: "byok-lin-anthropic",
    });
  });

  it("uses the operator's key on an isolated gateway whose owner stored none", async () => {
    const { send, upstreamKey } = await broker({ gatewayId: "lin" });

    await send().expect(200);

    expect(upstreamKey()).toBe("operator-anthropic-key");
  });

  it("refuses the call when the secret store cannot be read", async () => {
    const failure = new Error("secret store unavailable");
    const { send, fetchImpl, errors } = await broker({
      gatewayId: "lin",
      readSecret: async () => { throw failure; },
    });

    await send().expect(503);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors).toContain(failure);
  });

  it("installs the platform's user entitlements for the accounts it reads", async () => {
    const host = globalThis as typeof globalThis & { [ENTITLEMENTS]?: unknown };
    const installed = host[ENTITLEMENTS];
    delete host[ENTITLEMENTS];
    try {
      const { send, usageStore } = await broker({ gatewayId: "shared-1", accounts: platformAccounts });

      await send().expect(200);

      expect(usageStore.events).toHaveLength(1);
    } finally {
      host[ENTITLEMENTS] = installed;
    }
  });

  it("reports which provider keys the operator supplied", async () => {
    const { app } = await broker({ gatewayId: "shared-1", env: { OPENROUTER_API_KEY: "operator-openrouter-key" } });

    const health = await request(app).get("/healthz").expect(200);

    expect(health.body.providers).toMatchObject({ anthropic: false, openrouter: true, openai: false });
  });
});
