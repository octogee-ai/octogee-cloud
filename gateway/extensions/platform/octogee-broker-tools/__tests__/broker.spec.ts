import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrokerCatalog } from "../catalog.js";
import { readBrokerJson } from "../http.js";
import { registerBrokerInspection } from "../inspect.js";
const auth = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({ listAgentIds: (cfg: any) => cfg.agents.list.map((a: any) => a.id), resolveAgentDir: (cfg: any, id: string) => cfg.agents.list.find((a: any) => a.id === id)?.agentDir }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({ resolveApiKeyForProvider: auth }));
const price = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: .2, cacheWritePerMTok: 2.5 };
function context(agent = "a", api = "openai-responses") { return { config: { agents: { list: [{ id: "a", agentDir: "/agents/a" }, { id: "b", agentDir: "/agents/b" }] }, models: { providers: { "platform-openai": { baseUrl: "https://broker.example", api, models: [], headers: { "x-preserved": "yes" } } } } }, env: { PLATFORM_OPENAI_BASE_URL: "https://broker.example" }, agentDir: `/agents/${agent}` } as any; }
function catalog(agent = "a", extra = {}) { return { schemaVersion: 1, agentId: agent, provider: "openai", purpose: "model", providerCredentialConfigured: true, admission: "request-time", routes: [{ method: "POST", path: "/v1/responses" }, { method: "POST", path: "/v1/chat/completions" }], models: [{ provider: "openai", id: "test", label: "Test", contextTokens: 1000, maxOutputTokens: 100, reasoning: false, input: ["text"], pricing: price }], ...extra }; }
beforeEach(() => { auth.mockReset(); auth.mockImplementation(async ({ agentDir }: any) => ({ apiKey: `token-${agentDir}` })); });
describe("credential-scoped catalog", () => {
  it("does not inspect unresolved URLs or credentials without a canonical agent context", async () => {
    const ctx = context(); delete ctx.agentDir;
    ctx.config.models.providers["platform-openai"].baseUrl = "${UNRESOLVED_BROKER_URL}";
    const fetcher = vi.fn();
    await expect(createBrokerCatalog(fetcher).runtime(ctx)).resolves.toEqual({ providers: {} });
    expect(auth).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps two agents separate with numeric USD per million and preserved transport headers", async () => {
    const fetcher = vi.fn(async (_url, init) => Response.json(catalog(String(new Headers(init.headers).get("authorization")).endsWith("/b") ? "b" : "a")));
    const adapter = createBrokerCatalog(fetcher as any);
    for (const agent of ["a", "b"]) {
      const result = await adapter.runtime(context(agent)) as any;
      expect(result.providers["platform-openai"].models[0].cost).toEqual({ input: 2, output: 8, cacheRead: .2, cacheWrite: 2.5 });
      expect(result.providers["platform-openai"].headers).toEqual({ "x-preserved": "yes" });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("lists the Vertex rail's Claude models under platform-vertex with bare ids", async () => {
    const ctx = context(); const configured = ctx.config.models.providers["platform-openai"];
    ctx.config.models.providers = { "platform-vertex": { ...configured, api: "anthropic-messages" } }; ctx.env = { PLATFORM_VERTEX_BASE_URL: configured.baseUrl };
    const payload = catalog(); payload.provider = "vertex"; payload.routes = [{ method: "POST", path: "/v1/messages" }];
    payload.models[0] = { ...payload.models[0], provider: "vertex", id: "vertex/claude-sonnet-5", label: "Claude Sonnet 5" };
    const adapter = createBrokerCatalog(async () => Response.json(payload));
    const result = await adapter.runtime(ctx) as any;
    expect(result.providers["platform-vertex"].api).toBe("anthropic-messages");
    expect(result.providers["platform-vertex"].models[0]).toMatchObject({ id: "claude-sonnet-5", api: "anthropic-messages" });
    expect((await adapter.picker(ctx))[0]).toMatchObject({ provider: "platform-vertex", model: "claude-sonnet-5" });
  });
  it("keeps the vendor prefix on OpenRouter model ids", async () => {
    const ctx = context(); const configured = ctx.config.models.providers["platform-openai"];
    ctx.config.models.providers = { "platform-openrouter": { ...configured, api: "openai-completions" } }; ctx.env = { OPENROUTER_BASE_URL: configured.baseUrl };
    const payload = catalog(); payload.provider = "openrouter"; payload.routes = [{ method: "POST", path: "/v1/chat/completions" }];
    payload.models[0] = { ...payload.models[0], provider: "openrouter", id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1" };
    const adapter = createBrokerCatalog(async () => Response.json(payload));
    const result = await adapter.runtime(ctx) as any;
    expect(result.providers["platform-openrouter"].models[0]).toMatchObject({ id: "anthropic/claude-fable-5.1" });
    expect((await adapter.picker(ctx))[0]).toMatchObject({ provider: "platform-openrouter", model: "anthropic/claude-fable-5.1" });
  });
  it.each([["anthropic", "anthropic", "anthropic-messages", "ANTHROPIC_BASE_URL", "/v1/messages"], ["platform-openrouter", "openrouter", "openai-completions", "OPENROUTER_BASE_URL", "/v1/chat/completions"]])("retains %s provider transport and endpoint scope", async (id, provider, api, env, route) => {
    const ctx = context(); const configured = ctx.config.models.providers["platform-openai"];
    ctx.config.models.providers = { [id]: { ...configured, api } }; ctx.env = { [env]: configured.baseUrl };
    const payload = catalog(); payload.provider = provider; payload.routes = [{ method: "POST", path: route }]; payload.models[0].provider = provider;
    const result = await createBrokerCatalog(async () => Response.json(payload)).runtime(ctx) as any;
    expect(result.providers[id].api).toBe(api); expect(result.providers[id].models[0].api).toBe(api);
  });
  it("discovers Ember through the scoped Meta Responses catalog", async () => {
    const ctx = context();
    const configured = ctx.config.models.providers["platform-openai"];
    ctx.config.models.providers = { "platform-meta": { ...configured, api: "openai-responses" } };
    ctx.env = { PLATFORM_META_BASE_URL: configured.baseUrl };
    const payload = catalog();
    payload.provider = "meta";
    payload.routes = [{ method: "POST", path: "/v1/responses" }];
    payload.models[0] = { ...payload.models[0], provider: "meta", id: "muse-ember-1.0", label: "Muse Ember (max)" };
    const adapter = createBrokerCatalog(async () => Response.json(payload));
    const result = await adapter.runtime(ctx) as any;
    expect(result.providers["platform-meta"]).toMatchObject({
      api: "openai-responses", models: [{ id: "muse-ember-1.0", api: "openai-responses" }],
    });
    expect((await adapter.picker(ctx))[0]).toMatchObject({ provider: "platform-meta", model: "muse-ember-1.0" });
  });
  it("preserves the configured OpenAI chat completions transport", async () => {
    const result = await createBrokerCatalog(async () => Response.json(catalog())).runtime(context("a", "openai-completions")) as any;
    expect(result.providers["platform-openai"].api).toBe("openai-completions");
  });
  it.each([{ agentId: "b" }, { purpose: "embedding" }, { provider: "anthropic" }, { providerCredentialConfigured: false }])("refuses a mismatched credential scope %j", async extra => {
    await expect(createBrokerCatalog(async () => Response.json(catalog("a", extra))).runtime(context())).rejects.toThrow("metadata");
  });
  it("does not turn missing pricing into zero cost", async () => {
    const data = catalog(); delete (data.models[0] as any).pricing;
    const adapter = createBrokerCatalog(async () => Response.json(data));
    expect((await adapter.runtime(context()) as any).providers["platform-openai"].models).toEqual([]);
    expect((await adapter.picker(context()))[0].warnings).toContain("Complete runtime metadata/pricing unavailable");
  });
  it("rejects rotation before publishing and does not cache revoked metadata", async () => {
    auth.mockResolvedValueOnce({ apiKey: "old" }).mockResolvedValueOnce({ apiKey: "new" });
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(catalog())).mockResolvedValueOnce(new Response("private", { status: 401 }));
    const adapter = createBrokerCatalog(fetcher);
    await expect(adapter.runtime(context())).rejects.toThrow("unauthorized");
    await expect(adapter.runtime(context())).rejects.toThrow("unauthorized");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("refuses if the canonical agent is removed during the request", async () => {
    const ctx = context();
    await expect(createBrokerCatalog(async () => { ctx.config.agents.list = []; return Response.json(catalog()); }).runtime(ctx)).rejects.toThrow("unauthorized");
  });
});
describe("metadata transport bounds", () => {
  it.each([401, 403, 410, 503])("keeps %s metadata unavailable without exposing the response", async status => {
    await expect(readBrokerJson(new URL("https://broker.example/v1/catalog"), {}, async () => new Response("private-secret", { status }))).rejects.not.toThrow("private-secret");
  });
  it("rejects oversized responses", async () => {
    await expect(readBrokerJson(new URL("https://broker.example/v1/catalog"), {}, async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow("metadata");
  });
  it("honors cancellation without a stale cached result", async () => {
    const controller = new AbortController(); const ctx = context(); ctx.signal = controller.signal;
    const adapter = createBrokerCatalog(async () => { controller.abort(); return Response.json(catalog()); });
    await expect(adapter.runtime(ctx)).rejects.toThrow();
  });
});

function inspection(fetchImpl: any, current = () => true, params: any = { agentId: "a" }, client: any = { authenticatedUserId: "owner", authenticatedUserProfile: { profileId: "profile" } }, setup: { pluginConfig?: any; env?: NodeJS.ProcessEnv } = {}) {
  let handler: any; const respond = vi.fn(); const logger = { error: vi.fn() };
  registerBrokerInspection({ registerGatewayMethod: (_name: any, fn: any) => { handler = fn; }, pluginConfig: setup.pluginConfig ?? { brokerUrl: "https://broker.example" }, logger } as any,
    { fetchImpl, readToken: async () => "projected-ksa", env: setup.env ?? {} });
  return { run: () => handler({ params, client, respond, hasCurrentClientAuthority: current }), respond, logger };
}
describe("private inspection", () => {
  it("uses host-attested identity and strips unexpected credentials from responses", async () => {
    const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, agentId: "a", tier: "hobby", credential: { path: "platform_broker", provider: null, apiKey: "secret" }, apiKey: "secret" }));
    const test = inspection(fetcher); await test.run();
    expect(String(fetcher.mock.calls[0][0])).toBe("https://broker.example/internal/byok/broker-inspect");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ agentId: "a", requesterUid: "owner" });
    expect(test.respond.mock.calls[0][0]).toBe(true);
    expect(JSON.stringify(test.respond.mock.calls)).not.toContain("secret");
  });
  it("does not trust a wire requester UID or unattested service client", async () => {
    const fetcher = vi.fn();
    for (const test of [inspection(fetcher, () => true, { agentId: "a", requesterUid: "owner" }), inspection(fetcher, () => true, { agentId: "a" }, {})]) { await test.run(); expect(test.respond.mock.calls[0][0]).toBe(false); }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("falls back to the fleet broker, then the API, when the plugin config names no broker", async () => {
    const fetcher = vi.fn(async () => Response.json({ schemaVersion: 1, agentId: "a" }));
    for (const env of [{ FLEET_BROKER_URL: "https://fleet.example", OCTOGEE_API_URL: "https://api.example" }, { OCTOGEE_API_URL: "https://api.example" }]) {
      await inspection(fetcher, () => true, undefined, undefined, { pluginConfig: {}, env }).run();
    }
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://fleet.example/internal/byok/broker-inspect", "https://api.example/internal/byok/broker-inspect",
    ]);
  });
  it("logs and reports unavailable instead of guessing a broker when none is configured", async () => {
    const fetcher = vi.fn();
    for (const setup of [{ pluginConfig: {}, env: {} }, { pluginConfig: { brokerUrl: "" }, env: { FLEET_BROKER_URL: "", OCTOGEE_API_URL: "" } }]) {
      const test = inspection(fetcher, () => true, undefined, undefined, setup); await test.run();
      expect(test.respond).toHaveBeenCalledExactlyOnceWith(false, undefined, { code: "UNAVAILABLE", message: "Owner-authorized broker metadata unavailable" });
      expect(test.logger.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("no broker URL"));
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks authority after the private read", async () => {
    let allowed = true;
    const test = inspection(async () => { allowed = false; return Response.json({ schemaVersion: 1, agentId: "a", credits: { balanceUsd: 99 } }); }, () => allowed);
    await test.run(); expect(test.respond.mock.calls[0][0]).toBe(false); expect(JSON.stringify(test.respond.mock.calls)).not.toContain("99");
  });
});
