import plugin from "../index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/core";
import { registerBrokerProfiles } from "../broker-profiles.js";

vi.mock("openclaw/plugin-sdk/core", () => ({ definePluginEntry: (entry: unknown) => entry }));

it("registers operator profile materialization from the broker plugin", () => {
  const registerGatewayMethod = vi.fn();
  plugin.register({
    registerGatewayMethod,
    registerProvider: vi.fn(),
    registerModelCatalogProvider: vi.fn(),
  } as never);
  expect(registerGatewayMethod).toHaveBeenCalledWith(
    "octogee.brokerProfiles.materialize",
    expect.any(Function),
    { scope: "operator.admin" },
  );
});


vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveAgentDir: (config: { agents: { entries: Record<string, { agentDir?: string }> } }, id: string) =>
    config.agents.entries[id]?.agentDir ?? `/gateway/agents/${id}/agent`,
  listAgentIds: (config: { agents: { entries: Record<string, unknown> } }) => Object.keys(config.agents.entries),
}));

const AGENT = "octogee-alice-coach";
type Update = NonNullable<NonNullable<Parameters<typeof registerBrokerProfiles>[1]>["updateStore"]>;
type Store = Parameters<Parameters<Update>[0]["updater"]>[0];

function setup(env: NodeJS.ProcessEnv = { OPENROUTER_BASE_URL: "http://broker/openrouter", PLATFORM_OPENAI_BASE_URL: "http://broker/openai" }) {
  const store = { version: 1, profiles: {}, usageStats: {}, order: {} } as Store;
  const config: { agents: { entries: Record<string, { agentDir?: string }> } } = { agents: { entries: { [AGENT]: {} } } };
  let handler: (options: GatewayRequestHandlerOptions) => Promise<void> | void;
  let beforeUpdate = () => {};
  const updateStore = vi.fn(async (options: { agentDir?: string; updater: (store: Store) => boolean }): Promise<Store | null> => {
    beforeUpdate();
    const next = structuredClone(store);
    try {
      if (options.updater(next)) Object.assign(store, next);
      return structuredClone(store);
    } catch { return null; }
  });
  const registerGatewayMethod = vi.fn((_method, callback) => { handler = callback; });
  const logger = { error: vi.fn() };
  registerBrokerProfiles({ registerGatewayMethod, logger } as never, { env, updateStore });
  const respond = vi.fn();
  const request = async (params: Record<string, unknown> = { agentIds: [AGENT] }, current = () => true) => {
    respond.mockClear();
    await handler!({ params, context: { getRuntimeConfig: () => config }, respond, hasCurrentClientAuthority: current } as never);
    return respond.mock.calls[0];
  };
  return { store, config, updateStore, registerGatewayMethod, logger, request, beforeUpdate: (callback: () => void) => { beforeUpdate = callback; } };
}

beforeEach(() => vi.clearAllMocks());

describe("Gateway-owned broker profile materialization", () => {
  it("registers an operator-admin method and writes owner-bound refs through the native transaction", async () => {
    const h = setup();
    h.store.profiles["oauth:personal"] = { type: "oauth", provider: "openai-codex", access: "preserved", refresh: "preserved", expires: 123 };
    h.store.usageStats = { "oauth:personal": { lastUsed: 42 } };
    h.store.order = { "openai-codex": ["oauth:personal"] };
    const retained = structuredClone(h.store);
    expect(await h.request()).toEqual([true, { ok: true }]);
    expect(h.registerGatewayMethod).toHaveBeenCalledWith("octogee.brokerProfiles.materialize", expect.any(Function), { scope: "operator.admin" });
    expect(h.updateStore).toHaveBeenCalledWith({ agentDir: `/gateway/agents/${AGENT}/agent`, updater: expect.any(Function) });
    expect(h.store.profiles["anthropic:default"]).toEqual({ type: "api_key", provider: "anthropic", keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-${AGENT}` } });
    expect(h.store.profiles["platform-openrouter:default"]).toEqual({ type: "api_key", provider: "platform-openrouter", keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-openrouter-${AGENT}` } });
    expect(h.store.profiles["platform-openai:default"]).toEqual({ type: "api_key", provider: "platform-openai", keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-openai-${AGENT}` } });
    expect(h.store.profiles["oauth:personal"]).toEqual(retained.profiles["oauth:personal"]);
    expect(h.store.usageStats).toEqual(retained.usageStats);
    expect(h.store.order).toEqual(retained.order);
    const once = structuredClone(h.store);
    expect(await h.request()).toEqual([true, { ok: true }]);
    expect(h.store).toEqual(once);
  });

  it("installs the platform-vertex profile when the pod carries the Vertex rail", async () => {
    const h = setup({ PLATFORM_VERTEX_BASE_URL: "http://broker" });
    await h.request();
    expect(Object.keys(h.store.profiles)).toEqual(["anthropic:default", "platform-vertex:default"]);
    expect(h.store.profiles["platform-vertex:default"]).toEqual({ type: "api_key", provider: "platform-vertex", keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-vertex-${AGENT}` } });
  });

  it("installs a scoped Meta profile for an agent rostered after boot", async () => {
    const h = setup({ PLATFORM_META_BASE_URL: "http://broker/v1" });
    expect(await h.request()).toEqual([true, { ok: true }]);
    expect(h.store.profiles["platform-meta:default"]).toEqual({
      type: "api_key", provider: "platform-meta",
      keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-meta-${AGENT}` },
    });
  });

  it("installs only configured broker provider surfaces", async () => {
    const h = setup({});
    await h.request();
    expect(Object.keys(h.store.profiles)).toEqual(["anthropic:default"]);
  });

  it.each([
    { type: "oauth", provider: "anthropic", access: "keep", refresh: "keep", expires: 0 },
    { type: "api_key", provider: "foreign", keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-${AGENT}` } },
    { type: "api_key", provider: "anthropic", key: "keep" },
    { type: "api_key", provider: "anthropic", keyRef: { source: "env", provider: "gcp-secret-manager", id: `agent-model-token-${AGENT}` } },
    { type: "api_key", provider: "anthropic", keyRef: { source: "exec", provider: "foreign", id: `agent-model-token-${AGENT}` } },
    { type: "api_key", provider: "anthropic", keyRef: { source: "exec", provider: "gcp-secret-manager", id: "agent-model-token-octogee-bob-coach" } },
  ])("rejects a conflicting profile under the native lock: %j", async current => {
    const h = setup();
    h.beforeUpdate(() => { h.store.profiles["anthropic:default"] = current as Store["profiles"][string]; });
    const response = await h.request();
    expect(response?.[0]).toBe(false);
    expect(response?.[2]).toEqual({ code: "UNAVAILABLE", message: expect.stringContaining("broker profile ownership conflicts") });
    expect(h.store.profiles).toEqual({ "anthropic:default": current });
  });

  it.each([
    { agentIds: ["../other"] }, { agentIds: [] }, { agentIds: "agent" },
    { agentIds: [AGENT], path: "/other" }, { agentIds: Array(129).fill(AGENT) },
  ])("refuses invalid input without admitting a native write: %j", async params => {
    const h = setup();
    expect((await h.request(params))?.[2]?.code).toBe("INVALID_REQUEST");
    expect(h.updateStore).not.toHaveBeenCalled();
  });

  it("rejects an unrostered agent", async () => {
    const h = setup();
    expect((await h.request({ agentIds: ["octogee-bob-coach"] }))?.[0]).toBe(false);
    expect(h.updateStore).not.toHaveBeenCalled();
  });

  it.each(["removed", "relocated", "authority"])("rechecks %s ownership after waiting for the native lock", async condition => {
    const h = setup();
    h.beforeUpdate(() => {
      if (condition === "removed") h.config.agents.entries = {};
      if (condition === "relocated") h.config.agents.entries[AGENT] = { agentDir: "/other-owner" };
    });
    expect((await h.request(undefined, () => condition !== "authority"))?.[0]).toBe(false);
    expect(h.store.profiles).toEqual({});
  });

  it("does not acknowledge a native write refusal", async () => {
    const h = setup();
    h.updateStore.mockResolvedValueOnce(null);
    expect((await h.request())?.[2]).toEqual({ code: "UNAVAILABLE", message: "broker profile update unavailable" });
    expect(h.logger.error).toHaveBeenCalledOnce();
  });

  it("does not register during metadata discovery", () => {
    const registerGatewayMethod = vi.fn();
    registerBrokerProfiles({ registrationMode: "discovery", registerGatewayMethod } as never);
    expect(registerGatewayMethod).not.toHaveBeenCalled();
  });
});
