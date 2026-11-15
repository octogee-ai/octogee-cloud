import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  byosubSecretName,
  validateCodexCredential,
  validateClaudeCliCredential,
  validateClaudeCliToken,
  gatewayClaudeSsoClient,
  gatewayDeviceAuthClient,
  byosubConnectionView,
  isSafeGatewayId,
  brokerByosubFlow,
} from "./byosub.js";

describe("brokerByosubFlow — sidecar brokers the byosubFlows write via gateway identity", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.FLEET_BROKER_URL = "http://octogee-api.octogee.svc.cluster.local:3001";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.FLEET_BROKER_URL;
    delete process.env.OCTOGEE_API_URL;
  });

  it("POSTs flowId/agentId/provider to octogee-api /internal/byok/byosub-flow", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true }) } as any;
    }) as any;
    await brokerByosubFlow({ flowId: "f1", agentId: "octogee-x-coach", provider: "anthropic" });
    expect(calls[0].url).toBe(
      "http://octogee-api.octogee.svc.cluster.local:3001/internal/byok/byosub-flow",
    );
    expect(calls[0].body).toEqual({ flowId: "f1", agentId: "octogee-x-coach", provider: "anthropic" });
  });

  it("throws on a non-2xx broker response (no silent failure)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    })) as any;
    await expect(
      brokerByosubFlow({ flowId: "f1", agentId: "a", provider: "anthropic" }),
    ).rejects.toThrow(/403/);
  });
});

describe("byosubSecretName", () => {
  it("is owner-scoped and matches Chunk A secretNameFor", () => {
    expect(byosubSecretName("uid-1", "openai")).toBe("byosub-uid-1-openai");
  });
});

describe("validateCodexCredential — privileged write surface", () => {
  const good = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "a", refresh_token: "r", account_id: "acct" },
    last_refresh: "2026-05-16T00:00:00Z",
  });

  it("accepts a well-formed codex auth.json", () => {
    expect(validateCodexCredential(good)).toEqual({ ok: true });
  });

  it("rejects empty / non-JSON / non-object", () => {
    expect(validateCodexCredential("").ok).toBe(false);
    expect(validateCodexCredential("   ").ok).toBe(false);
    expect(validateCodexCredential("not json").ok).toBe(false);
    expect(validateCodexCredential("[]").ok).toBe(false);
    expect(validateCodexCredential("42").ok).toBe(false);
  });

  it("requires the fields codex restore actually needs", () => {
    expect(validateCodexCredential(JSON.stringify({ tokens: {} })).ok).toBe(false);
    expect(
      validateCodexCredential(JSON.stringify({ auth_mode: "chatgpt", tokens: {} })).ok,
    ).toBe(false);
    expect(
      validateCodexCredential(
        JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }),
      ).ok,
    ).toBe(false);
    expect(
      validateCodexCredential(
        JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "r" } }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an oversized payload (no attacker-controlled blobs into the credential sink)", () => {
    const huge = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "a".repeat(40_000), refresh_token: "r" },
    });
    expect(validateCodexCredential(huge).ok).toBe(false);
  });
});

describe("validateClaudeCliToken — Claude subscription setup-token (privileged write surface)", () => {
  it("accepts a well-formed sk-ant-oat setup-token", () => {
    expect(validateClaudeCliToken("sk-ant-oat01-abcDEF123")).toEqual({ ok: true });
  });

  it("trims paste whitespace/newlines before checking", () => {
    expect(validateClaudeCliToken("  sk-ant-oat01-abc\n")).toEqual({ ok: true });
  });

  it("rejects empty / whitespace-only", () => {
    expect(validateClaudeCliToken("").ok).toBe(false);
    expect(validateClaudeCliToken("   ").ok).toBe(false);
  });

  it("rejects an API key (sk-ant-api…) — a subscription token is sk-ant-oat…, not the API key", () => {
    expect(validateClaudeCliToken("sk-ant-api03-deadbeef").ok).toBe(false);
  });

  it("rejects junk / wrong-provider tokens", () => {
    expect(validateClaudeCliToken("ghp_whatever").ok).toBe(false);
    expect(validateClaudeCliToken("just-text").ok).toBe(false);
  });

  it("rejects an oversized blob (no attacker-controlled blobs into the credential sink)", () => {
    expect(validateClaudeCliToken("sk-ant-oat01-" + "a".repeat(40_000)).ok).toBe(false);
  });
});

describe("validateClaudeCliCredential — Claude subscription setup-token or SSO JSON", () => {
  const ssoCredential = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-oat01-refresh",
      expiresAt: 1_782_344_797_336,
    },
  });

  it("accepts legacy setup-token and Claude SSO .credentials.json payloads", () => {
    expect(validateClaudeCliCredential("sk-ant-oat01-abc")).toEqual({ ok: true });
    expect(validateClaudeCliCredential(ssoCredential)).toEqual({ ok: true });
  });

  it("rejects malformed SSO JSON without falling back to setup-token handling", () => {
    expect(validateClaudeCliCredential('{"claudeAiOauth":{}}').ok).toBe(false);
    expect(
      validateClaudeCliCredential(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oat01-access",
            refreshToken: "sk-ant-oat01-refresh",
            expiresAt: 0,
          },
        }),
      ).ok,
    ).toBe(false);
  });
});

describe("gatewayDeviceAuthClient — uses the local fleet controller", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = "k";
    vi.stubEnv("GATEWAY_ID", "walter");
    vi.stubEnv("FLEET_CONTROLLER_PORT", "");
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("starts device auth on loopback without Kubernetes DNS", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ flowId: "f" }) } as any;
    }) as any;
    await gatewayDeviceAuthClient().start({ gatewayId: "walter", agentId: "octogee-x-coach" });
    expect(seen[0]).toBe(
      "http://127.0.0.1:3003/internal/byosub/device-auth/start",
    );
  });

  it("polls device auth on the configured local fleet controller port", async () => {
    vi.stubEnv("FLEET_CONTROLLER_PORT", "9009");
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ state: "x" }) } as any;
    }) as any;
    await gatewayDeviceAuthClient().status({ gatewayId: "walter", flowId: "f1" });
    expect(seen[0]).toBe(
      "http://127.0.0.1:9009/internal/byosub/device-auth/status/f1",
    );
  });

  it.each(["other-gateway", ""])("rejects a mismatched or missing local gateway identity: %s", async (localGatewayId) => {
    vi.stubEnv("GATEWAY_ID", localGatewayId);
    globalThis.fetch = vi.fn();
    await expect(
      gatewayDeviceAuthClient().start({ gatewayId: "walter", agentId: "a" }),
    ).rejects.toThrow("Subscription auth must run on the assigned gateway");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx gateway response (surfaced, not swallowed)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    })) as any;
    await expect(
      gatewayDeviceAuthClient().start({ gatewayId: "walter", agentId: "a" }),
    ).rejects.toThrow(/502/);
  });
});

describe("gatewayClaudeSsoClient — uses the local fleet controller", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_KEY = "k";
    vi.stubEnv("GATEWAY_ID", "walter");
    vi.stubEnv("FLEET_CONTROLLER_PORT", "");
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  it("starts Claude SSO on loopback without Kubernetes DNS", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ flowId: "f" }) } as any;
    }) as any;
    await gatewayClaudeSsoClient().start({
      gatewayId: "walter",
      agentId: "octogee-x-coach",
    });
    expect(seen[0]).toBe(
      "http://127.0.0.1:3003/internal/byosub/claude-sso/start",
    );
  });

  it("polls Claude SSO on the configured local fleet controller port", async () => {
    vi.stubEnv("FLEET_CONTROLLER_PORT", "9009");
    globalThis.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ state: "pending" }),
    })) as any;
    await gatewayClaudeSsoClient().status({ gatewayId: "walter", flowId: "f1" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9009/internal/byosub/claude-sso/status/f1",
      expect.anything(),
    );
  });

  it("authenticates the local Claude SSO hop with the per-gateway token", async () => {
    delete process.env.INTERNAL_SERVICE_KEY;
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      seen.push(new Headers(init.headers).get("X-Internal-Service-Key") ?? "");
      return { ok: true, json: async () => ({ flowId: "f" }) } as any;
    }) as any;
    await gatewayClaudeSsoClient().start({
      gatewayId: "walter",
      agentId: "octogee-x-coach",
    });
    expect(seen).toEqual(["gateway-token"]);
  });

  it("submits the browser code to the local Claude SSO manager", async () => {
    const seen: Array<{ url: string; body: string | null }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), body: init.body ?? null });
      return { ok: true, json: async () => ({ state: "submitting" }) } as any;
    }) as any;
    await gatewayClaudeSsoClient().submit({
      gatewayId: "walter",
      flowId: "flow-1",
      code: "code#state",
    });
    expect(seen[0]).toEqual({
      url: "http://127.0.0.1:3003/internal/byosub/claude-sso/submit",
      body: JSON.stringify({ flowId: "flow-1", code: "code#state" }),
    });
  });
});

describe("byosubConnectionView — provider-set connection status", () => {
  it("no ref / no providers → not connected with an empty provider map", () => {
    expect(byosubConnectionView(undefined)).toEqual({ connected: false, providers: {} });
    expect(byosubConnectionView(null)).toEqual({ connected: false, providers: {} });
    expect(byosubConnectionView({})).toEqual({ connected: false, providers: {} });
    expect(byosubConnectionView({ providers: {} })).toEqual({ connected: false, providers: {} });
  });

  it("reports every provider independently and aggregates connected=true when any provider is connected", () => {
    expect(
      byosubConnectionView({
        providers: {
          openai: { provider: "openai", secretName: "s-openai", status: "connected" },
          anthropic: { provider: "anthropic", secretName: "s-anthropic", status: "needs_reauth" },
        },
      }),
    ).toEqual({
      connected: true,
      providers: {
        openai: {
          connected: true,
          provider: "openai",
          status: "connected",
          modelCredentialProvider: "openai-codex",
        },
        anthropic: {
          connected: false,
          provider: "anthropic",
          status: "needs_reauth",
          modelCredentialProvider: "claude-cli",
        },
      },
    });
  });
});

describe("isSafeGatewayId (Copilot #992 — Firestore doc-id safety; clean 400 not 500)", () => {
  it("accepts real slug-like gateway ids", () => {
    expect(isSafeGatewayId("default")).toBe(true);
    expect(isSafeGatewayId("walter")).toBe(true);
    expect(isSafeGatewayId("walter-echo")).toBe(true);
  });
  it("rejects path-traversal / empty / overlong / non-string (would throw in .doc())", () => {
    expect(isSafeGatewayId("gw/evil")).toBe(false);
    expect(isSafeGatewayId("../x")).toBe(false);
    expect(isSafeGatewayId("")).toBe(false);
    expect(isSafeGatewayId("-leading-hyphen")).toBe(false);
    expect(isSafeGatewayId("trailing-hyphen-")).toBe(false);
    expect(isSafeGatewayId("Canary_1-x")).toBe(false);
    expect(isSafeGatewayId("a".repeat(33))).toBe(false);
    expect(isSafeGatewayId(undefined)).toBe(false);
    expect(isSafeGatewayId(123)).toBe(false);
    expect(isSafeGatewayId("has space")).toBe(false);
  });
});
