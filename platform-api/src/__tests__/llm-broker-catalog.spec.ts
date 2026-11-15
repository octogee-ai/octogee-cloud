import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { modelCatalogForProvider } from "@octogee/shared/types/model-catalog";
import { createLlmBrokerApp } from "../llm-broker-app.js";
import {
  InMemoryModelBrokerTokenStore,
  type ModelBrokerProvider,
} from "../lib/model-broker-tokens.js";
import { operatorRailRegistry } from "../lib/model-broker-rails.js";

async function credential(store: InMemoryModelBrokerTokenStore, provider: ModelBrokerProvider, owner = "alice", purpose: "model" | "embeddings" = "model") {
  return store.issueToken({
    gatewayId: `gateway-${owner}`, ownerUid: owner, provider, purpose,
    secretName: `private-${owner}`, now: 1_000, ttlSeconds: 60,
    trace: { source: "shared_agent_model_token", ownerSlug: owner, agentId: `octogee-${owner}-coach` },
  });
}

describe("credential-scoped broker catalog", () => {
  it("limits catalog requests by verified owner and gateway before resolving the provider key", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const alice = await credential(store, "openai");
    const bob = await credential(store, "openai", "bob");
    const providerKeyResolver = vi.fn(async () => ({ apiKey: "fixture-key", source: "platform" as const }));
    const app = createLlmBrokerApp({ rails: operatorRailRegistry(), store, providerKeys: {}, now: () => 2_000, providerKeyResolver });
    for (let index = 0; index < 120; index++) {
      await request(app).get("/v1/catalog").set("x-api-key", alice.token).expect(200);
    }
    await request(app).get("/v1/catalog").set("x-api-key", alice.token).expect(429);
    expect(providerKeyResolver).toHaveBeenCalledTimes(120);
    await request(app).get("/v1/catalog").set("x-api-key", bob.token).expect(200);
  });

  it.each(["anthropic", "openai", "openrouter"] as const)("reports only %s routes and registered models without billing or upstream calls", async (provider) => {
    const store = new InMemoryModelBrokerTokenStore();
    const { token } = await credential(store, provider);
    const fetchImpl = vi.fn();
    const resolveGrant = vi.fn();
    const app = createLlmBrokerApp({ rails: operatorRailRegistry(), store, providerKeys: { [provider]: "private-provider-key" }, fetchImpl, resolveGrant, now: () => 2_000 });

    const result = await request(app).get("/v1/catalog")
      .set("authorization", `Bearer ${token}`)
      .set("x-clawrouter-agent-id", "octogee-bob-coach")
      .query({ ownerUid: "bob", provider: "other" }).expect(200);

    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toMatchObject({
      schemaVersion: 1, provider, purpose: "model", agentId: "octogee-alice-coach",
      admission: "request-time", providerCredentialConfigured: true,
    });
    expect(result.body.models).toEqual(modelCatalogForProvider(provider));
    const paths = result.body.routes.map((route: { path: string }) => route.path);
    expect(paths).toContain(provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
    expect(paths.includes("/v1/responses")).toBe(provider === "openai");
    expect(paths).not.toContain("/v1/embeddings");
    expect(result.text).not.toContain("private-");
    expect(result.text).not.toContain(token);
    expect(result.body).not.toHaveProperty("limits");
    expect(result.body).not.toHaveProperty("balance");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveGrant).not.toHaveBeenCalled();
  });

  it("keeps separate agent credentials separate and preserves unknown pricing", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const alice = await credential(store, "anthropic");
    const bob = await credential(store, "openai", "bob");
    const app = createLlmBrokerApp({ rails: operatorRailRegistry(), store, providerKeys: { anthropic: "a", openai: "b" }, now: () => 2_000 });
    const [a, b] = await Promise.all([
      request(app).get("/v1/catalog").set("x-api-key", alice.token).expect(200),
      request(app).get("/v1/catalog").set("x-api-key", bob.token).expect(200),
    ]);
    expect(a.body.agentId).toBe("octogee-alice-coach");
    expect(b.body.agentId).toBe("octogee-bob-coach");
    expect(a.body.models.every((model: { provider: string }) => model.provider === "anthropic")).toBe(true);
    expect(b.body.models.every((model: { provider: string }) => model.provider === "openai")).toBe(true);
    for (const model of modelCatalogForProvider("anthropic").filter((entry) => !entry.pricing)) {
      expect(a.body.models.find((entry: { id: string }) => entry.id === model.id)).not.toHaveProperty("pricing");
    }
  });

  it.each(["unknown", "expired", "revoked", "embeddings", "owner-disabled", "unconfigured"] as const)("refuses %s credentials before catalog disclosure", async (reason) => {
    const store = new InMemoryModelBrokerTokenStore();
    const issued = await credential(store, "openai", "alice", reason === "embeddings" ? "embeddings" : "model");
    if (reason === "revoked") await store.revokeGatewayToken({ gatewayId: "gateway-alice", provider: "openai", secretName: "private-alice" });
    const fetchImpl = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store, providerKeys: reason === "unconfigured" ? {} : { openai: "provider-key" },
      now: () => reason === "expired" ? 61_000 : 2_000,
      resolveOwnerAccess: async () => reason !== "owner-disabled", fetchImpl,
    });
    const status = ["unknown", "expired", "revoked"].includes(reason) ? 401 : reason === "unconfigured" ? 503 : 403;
    const result = await request(app).get("/v1/catalog")
      .set("x-api-key", reason === "unknown" ? "unknown" : issued.token).expect(status);
    expect(result.body).not.toHaveProperty("models");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["revoked", "expired", "owner-disabled"] as const)("rechecks %s authority after awaited credential resolution", async (reason) => {
    const store = new InMemoryModelBrokerTokenStore();
    const { token } = await credential(store, "openai");
    let clock = 2_000;
    let active = true;
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store, providerKeys: {}, now: () => clock, resolveOwnerAccess: async () => active,
      providerKeyResolver: async () => {
        if (reason === "revoked") await store.revokeGatewayToken({ gatewayId: "gateway-alice", provider: "openai", secretName: "private-alice" });
        if (reason === "expired") clock = 61_000;
        if (reason === "owner-disabled") active = false;
        return { apiKey: "private-provider-key", source: "platform" };
      },
    });
    const result = await request(app).get("/v1/catalog").set("x-api-key", token)
      .expect(reason === "owner-disabled" ? 403 : 401);
    expect(result.body).not.toHaveProperty("models");
  });

  it("reports unavailable provider metadata without exposing resolver errors", async () => {
    const store = new InMemoryModelBrokerTokenStore();
    const { token } = await credential(store, "openai");
    const onMeteringError = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store, providerKeys: {}, now: () => 2_000, onMeteringError,
      providerKeyResolver: async () => { throw new Error("private-credential-diagnostic"); },
    });
    const result = await request(app).get("/v1/catalog").set("x-api-key", token).expect(503);
    expect(result.text).not.toContain("private-");
    expect(onMeteringError).toHaveBeenCalledOnce();
  });

  it("keeps token-store failures private", async () => {
    const onMeteringError = vi.fn();
    const app = createLlmBrokerApp({
      rails: operatorRailRegistry(),
      store: { lookupToken: async () => { throw new Error("private-token-store-details"); } },
      providerKeys: {}, onMeteringError,
    });
    const result = await request(app).get("/v1/catalog").set("x-api-key", "unknown").expect(503);
    expect(result.body).toEqual({ error: "model catalog unavailable" });
    expect(onMeteringError).toHaveBeenCalledOnce();
  });
});
