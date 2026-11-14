import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConfiguredGatewayModelKeyIssuerBackend,
  createGatewayModelKeySourceIssuer,
  createHttpGatewayModelKeyIssuerBackend,
  type GatewayModelKeyIssuerBackend,
} from "../model-key-source-issuer.js";
import { gatewayModelKeySourceLabels } from "../model-key-secret-ensurer.js";

function validSource(value = "sk-ant-capped") {
  return { value, labels: gatewayModelKeySourceLabels("jack") };
}

function makeDeps(overrides: Partial<Parameters<typeof createGatewayModelKeySourceIssuer>[0]> = {}) {
  return {
    readSourceSecret: vi.fn(async () => null),
    writeSourceSecret: vi.fn(async () => undefined),
    deleteSourceSecret: vi.fn(async () => ({ deleted: false })),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createGatewayModelKeySourceIssuer", () => {
  it("leaves an existing labeled capped source unchanged", async () => {
    const deps = makeDeps({
      readSourceSecret: vi.fn(async () => validSource()),
    });
    const issuer = createGatewayModelKeySourceIssuer(deps);

    const result = await issuer.syncGatewayModelKeySource({
      gatewayId: "jack",
      gatewayClass: "isolated",
      desiredStatus: "running",
    });

    expect(result).toMatchObject({ action: "unchanged", changed: false });
    expect(deps.writeSourceSecret).not.toHaveBeenCalled();
    expect(deps.deleteSourceSecret).not.toHaveBeenCalled();
  });

  it("fails closed when a user is missing a source and no issuer backend is configured", async () => {
    const deps = makeDeps();
    const issuer = createGatewayModelKeySourceIssuer(deps);

    const result = await issuer.syncGatewayModelKeySource({
      gatewayId: "jack",
      gatewayClass: "isolated",
      desiredStatus: "running",
    });

    expect(result).toMatchObject({
      action: "skipped",
      changed: false,
      reason: "missing_issuer",
    });
    expect(deps.writeSourceSecret).not.toHaveBeenCalled();
  });

  it("writes a labeled Secret Manager source only after the backend returns a capped Anthropic key", async () => {
    const deps = makeDeps({
      backend: {
        issueGatewayModelKey: vi.fn<GatewayModelKeyIssuerBackend["issueGatewayModelKey"]>(async () => ({
          value: " sk-ant-capped ",
          provider: "anthropic",
          capped: true,
        })),
      },
    });
    const issuer = createGatewayModelKeySourceIssuer(deps);

    const result = await issuer.syncGatewayModelKeySource({
      gatewayId: "jack",
      gatewayClass: "isolated",
      desiredStatus: "running",
      ownerUid: "uid-jack",
    });

    expect(result).toMatchObject({ action: "issued", changed: true });
    expect(deps.writeSourceSecret).toHaveBeenCalledWith({
      name: "gateway-model-key-jack",
      value: "sk-ant-capped",
      labels: gatewayModelKeySourceLabels("jack"),
    });
  });

  it("rejects issuer output that is not explicitly capped", async () => {
    const deps = makeDeps({
      backend: {
        issueGatewayModelKey: vi.fn<GatewayModelKeyIssuerBackend["issueGatewayModelKey"]>(async () => ({
          value: "sk-ant-uncapped",
          provider: "anthropic",
          capped: false,
        }) as never),
      },
    });
    const issuer = createGatewayModelKeySourceIssuer(deps);

    await expect(
      issuer.syncGatewayModelKeySource({
        gatewayId: "jack",
        gatewayClass: "isolated",
        desiredStatus: "running",
      }),
    ).rejects.toThrow(/invalid or uncapped/);
    expect(deps.writeSourceSecret).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing source with invalid labels", async () => {
    const deps = makeDeps({
      readSourceSecret: vi.fn(async () => ({
        value: "sk-ant-old",
        labels: { provider: "anthropic" },
      })),
      backend: {
        issueGatewayModelKey: vi.fn<GatewayModelKeyIssuerBackend["issueGatewayModelKey"]>(async () => ({
          value: "sk-ant-new",
          provider: "anthropic",
          capped: true,
        })),
      },
    });
    const issuer = createGatewayModelKeySourceIssuer(deps);

    const result = await issuer.syncGatewayModelKeySource({
      gatewayId: "jack",
      gatewayClass: "isolated",
      desiredStatus: "running",
    });

    expect(result).toMatchObject({
      action: "skipped",
      reason: "invalid_source_labels",
    });
    expect(deps.writeSourceSecret).not.toHaveBeenCalled();
  });

  it("issues a broker token source for isolated gateways", async () => {
    const deps = makeDeps({
      backend: {
        issueGatewayModelKey: vi.fn<GatewayModelKeyIssuerBackend["issueGatewayModelKey"]>(async () => ({
          value: "ogk_walter_token",
          provider: "anthropic",
          capped: true,
        })),
      },
    });
    const issuer = createGatewayModelKeySourceIssuer(deps);

    const result = await issuer.syncGatewayModelKeySource({
      gatewayId: "walter",
      gatewayClass: "isolated",
      desiredStatus: "running",
      ownerUid: "uid-walter",
    });

    expect(result).toMatchObject({ action: "issued", changed: true });
    expect(deps.writeSourceSecret).toHaveBeenCalledWith({
      name: "gateway-model-key-walter",
      value: "ogk_walter_token",
      labels: gatewayModelKeySourceLabels("walter"),
    });
    expect(deps.deleteSourceSecret).not.toHaveBeenCalled();
  });

  it("does not call revoke when policy teardown finds no source secret", async () => {
    const revokeGatewayModelKey = vi.fn(async () => undefined);
    const deps = makeDeps({
      backend: {
        issueGatewayModelKey: vi.fn(async () => null),
        revokeGatewayModelKey,
      },
    });
    const issuer = createGatewayModelKeySourceIssuer(deps);

    const result = await issuer.syncGatewayModelKeySource({
      gatewayId: "jack",
      gatewayClass: "shared",
      desiredStatus: "running",
    });

    expect(result).toMatchObject({
      action: "skipped",
      reason: "non_builder",
      changed: false,
    });
    expect(revokeGatewayModelKey).not.toHaveBeenCalled();
    expect(deps.deleteSourceSecret).not.toHaveBeenCalled();
  });
});

describe("createHttpGatewayModelKeyIssuerBackend", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("posts the gateway identity and parses a capped Anthropic key response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        apiKey: "sk-ant-capped",
        provider: "anthropic",
        capped: true,
      }),
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    const backend = createHttpGatewayModelKeyIssuerBackend({
      issueUrl: "https://issuer.example/issue",
      bearerToken: "issuer-token",
    });

    const result = await backend.issueGatewayModelKey({
      gatewayId: "jack",
      ownerUid: "uid-jack",
      secretName: "gateway-model-key-jack",
    });

    expect(result).toEqual({
      value: "sk-ant-capped",
      provider: "anthropic",
      capped: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://issuer.example/issue",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer issuer-token",
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          gatewayId: "jack",
          ownerUid: "uid-jack",
          secretName: "gateway-model-key-jack",
          provider: "anthropic",
        }),
      }),
    );
  });
});

describe("createConfiguredGatewayModelKeyIssuerBackend", () => {
  it("is disabled unless GATEWAY_MODEL_KEY_ISSUER_URL is set", () => {
    expect(createConfiguredGatewayModelKeyIssuerBackend({})).toBeUndefined();
    expect(
      createConfiguredGatewayModelKeyIssuerBackend({
        GATEWAY_MODEL_KEY_ISSUER_URL: "https://issuer.example/issue",
      }),
    ).toBeDefined();
  });
});
