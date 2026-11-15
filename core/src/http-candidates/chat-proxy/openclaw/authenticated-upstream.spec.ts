import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type WebSocket as ServerWebSocket } from "ws";

import { generateIdentity } from "@octogee/shared/types/device-identity";

import {
  OpenclawWireError,
  openUpstream,
  requestDevicePairBootstrapToken,
} from "./upstream.js";
import {
  openAuthenticatedUpstream,
  type AuthenticatedUpstreamDeps,
} from "./authenticated-upstream.js";

function fakeSocket(label: string): WebSocket {
  return { label, terminate: vi.fn() } as unknown as WebSocket;
}

function depsForTest(): AuthenticatedUpstreamDeps {
  const identity = generateIdentity();
  return {
    fetchGatewayAuth: vi.fn(),
    serviceClientAddress: vi.fn(() => "10.128.0.75"),
    openUpstream: vi.fn(),
    requestDevicePairBootstrapToken: vi.fn(async () => "test-bootstrap-token"),
    clearGatewayDeviceToken: vi.fn(async () => undefined),
    invalidateGatewayToken: vi.fn(),
    persistGatewayDeviceToken: vi.fn(async () => undefined),
    getIdentity: vi.fn(() => identity),
  };
}

describe("openAuthenticatedUpstream", () => {
  it("completes the shared-token setup RPC and bootstrap reconnect over the real wire client", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const connectAuth: unknown[] = [];
    const connectScopes: unknown[] = [];
    const fullAccessPairingScopes = [
      "operator.admin",
      "operator.approvals",
      "operator.questions",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ];
    let setupParams: unknown;
    let nonce = 0;
    wss.on("connection", (ws: ServerWebSocket) => {
      nonce += 1;
      ws.send(JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: `nonce-${nonce}` },
      }));
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.method === "connect") {
          connectAuth.push(frame.params.auth);
          connectScopes.push(frame.params.scopes);
          const paired = frame.params.auth?.bootstrapToken === "one-time-bootstrap-token";
          if (paired && JSON.stringify(frame.params.scopes) !== JSON.stringify(fullAccessPairingScopes)) {
            ws.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message: "bootstrap_token_invalid" },
            }));
            return;
          }
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: `c${nonce}` },
              features: { methods: [], events: [] },
              snapshot: {},
              policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
              ...(paired ? {
                auth: {
                  deviceToken: "issued-device-token",
                  role: "operator",
                  scopes: ["operator.admin"],
                },
              } : {}),
            },
          }));
          return;
        }
        if (frame.method === "device.pair.setupCode") {
          setupParams = frame.params;
          const expiresAtMs = Date.now() + 60_000;
          ws.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              setupId: "setup-1",
              setupCode: Buffer.from(JSON.stringify({
                url: frame.params.publicUrl,
                bootstrapToken: "one-time-bootstrap-token",
                expiresAtMs,
              }), "utf8").toString("base64url"),
              gatewayUrl: frame.params.publicUrl,
              auth: "token",
              urlSource: "request.publicUrl",
              access: "full",
              expiresAtMs,
            },
          }));
        }
      });
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}`;
    const deps = depsForTest();
    deps.openUpstream = openUpstream;
    deps.requestDevicePairBootstrapToken = requestDevicePairBootstrapToken;
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({
      source: "legacy-token",
      token: "shared-gateway-token",
    });

    try {
      const ws = await openAuthenticatedUpstream({
        gatewayId: "eggman-devdays",
        url,
        timeoutMs: 10_000,
      }, deps);
      ws.close();

      expect(connectAuth).toEqual([
        { token: "shared-gateway-token" },
        { bootstrapToken: "one-time-bootstrap-token" },
      ]);
      expect(connectScopes[1]).toEqual(fullAccessPairingScopes);
      expect(connectScopes[1]).not.toContain("operator.pairing");
      expect(setupParams).toEqual({
        publicUrl: `ws://127.0.0.1:${port}`,
        includeQr: false,
      });
      expect(deps.persistGatewayDeviceToken).toHaveBeenCalledWith({
        token: "issued-device-token",
      });
    } finally {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("rejects a setup response that omits the required full-access profile", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws: ServerWebSocket) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        const expiresAtMs = Date.now() + 60_000;
        ws.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            setupCode: Buffer.from(JSON.stringify({
              url: frame.params.publicUrl,
              bootstrapToken: "one-time-bootstrap-token",
              expiresAtMs,
            }), "utf8").toString("base64url"),
            expiresAtMs,
          },
        }));
      });
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    try {
      await expect(requestDevicePairBootstrapToken({
        ws,
        url: `http://127.0.0.1:${port}`,
        timeoutMs: 10_000,
      })).rejects.toMatchObject({ code: "invalid-response" });
    } finally {
      ws.terminate();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("pairs a first-run local backend through a one-time upstream bootstrap token", async () => {
    const enrollment = fakeSocket("shared-token-enrollment");
    const paired = fakeSocket("bootstrap-paired");
    const requestDevicePairBootstrapToken = vi.fn(async () => "one-time-bootstrap-token");
    const deps = {
      ...depsForTest(),
      requestDevicePairBootstrapToken,
    } as AuthenticatedUpstreamDeps & {
      requestDevicePairBootstrapToken: typeof requestDevicePairBootstrapToken;
    };
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "legacy-token", token: "shared-gateway-token" });
    vi.mocked(deps.openUpstream)
      .mockResolvedValueOnce(enrollment)
      .mockImplementationOnce(async (params) => {
        await params.onDeviceToken?.({ deviceToken: "issued-device-token" });
        return paired;
      });

    await expect(openAuthenticatedUpstream({
      gatewayId: "eggman-devdays",
      url: "http://octogee-gateway-eggman.namespace.svc.cluster.local:18789",
      pairingUrl: "http://127.0.0.1:18789",
      timeoutMs: 10_000,
    }, deps)).resolves.toBe(paired);

    expect(requestDevicePairBootstrapToken).toHaveBeenCalledWith({
      ws: enrollment,
      url: "http://127.0.0.1:18789",
      timeoutMs: 10_000,
    });
    expect(enrollment.terminate).toHaveBeenCalledTimes(1);
    expect(deps.openUpstream).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.openUpstream).mock.calls[0]?.[0]).toMatchObject({
      url: "http://127.0.0.1:18789",
      token: "shared-gateway-token",
      deviceToken: undefined,
    });
    expect(vi.mocked(deps.openUpstream).mock.calls[1]?.[0]).toMatchObject({
      url: "http://127.0.0.1:18789",
      bootstrapToken: "one-time-bootstrap-token",
      token: undefined,
      deviceToken: undefined,
      scopes: [
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    });
    expect(deps.persistGatewayDeviceToken).toHaveBeenCalledWith({
      token: "issued-device-token",
    });
  });

  it("fails closed when the bootstrap reconnect does not issue a persistable device token", async () => {
    const deps = depsForTest();
    const enrollment = fakeSocket("shared-token-enrollment");
    const unpaired = fakeSocket("bootstrap-without-device-token");
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({
      source: "legacy-token",
      token: "shared-gateway-token",
    });
    vi.mocked(deps.openUpstream)
      .mockResolvedValueOnce(enrollment)
      .mockResolvedValueOnce(unpaired);

    await expect(openAuthenticatedUpstream({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
    }, deps)).rejects.toMatchObject({ code: "invalid-response" });

    expect(enrollment.terminate).toHaveBeenCalledTimes(1);
    expect(unpaired.terminate).toHaveBeenCalledTimes(1);
    expect(deps.persistGatewayDeviceToken).not.toHaveBeenCalled();
  });

  it("keeps an already-paired shared-token connection when hello reissues its device token", async () => {
    const deps = depsForTest();
    const paired = fakeSocket("already-paired");
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({
      source: "legacy-token",
      token: "shared-gateway-token",
    });
    vi.mocked(deps.openUpstream).mockImplementationOnce(async (params) => {
      await params.onDeviceToken?.({ deviceToken: "reissued-device-token" });
      return paired;
    });

    await expect(openAuthenticatedUpstream({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
    }, deps)).resolves.toBe(paired);

    expect(deps.requestDevicePairBootstrapToken).not.toHaveBeenCalled();
    expect(paired.terminate).not.toHaveBeenCalled();
    expect(deps.persistGatewayDeviceToken).toHaveBeenCalledWith({
      token: "reissued-device-token",
    });
  });

  it("reuses the non-pairing bootstrap scopes for a persisted device token", async () => {
    const deps = depsForTest();
    const paired = fakeSocket("persisted-device-token");
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({
      source: "device-token-file",
      deviceToken: "persisted-device-token",
    });
    vi.mocked(deps.openUpstream).mockResolvedValue(paired);

    await expect(openAuthenticatedUpstream({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
    }, deps)).resolves.toBe(paired);

    expect(deps.openUpstream).toHaveBeenCalledWith(expect.objectContaining({
      deviceToken: "persisted-device-token",
      scopes: [
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    }));
  });

  it("clears a mismatched device token and re-enrolls with legacy auth", async () => {
    const deps = depsForTest();
    const enrollment = fakeSocket("shared-token-enrollment");
    const recovered = fakeSocket("recovered");
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "device-token-file", deviceToken: "stale-device-token" })
      .mockResolvedValueOnce({ source: "legacy-token", token: "legacy-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("auth-failed", "device token mismatch"))
      .mockResolvedValueOnce(enrollment)
      .mockImplementationOnce(async (params) => {
        await params.onDeviceToken?.({ deviceToken: "replacement-device-token" });
        return recovered;
      });

    const result = await openAuthenticatedUpstream({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
      timeoutMs: 10_000,
    }, deps);

    expect(result).toBe(recovered);
    expect(deps.clearGatewayDeviceToken).toHaveBeenCalledTimes(1);
    expect(deps.invalidateGatewayToken).not.toHaveBeenCalled();
    expect(deps.fetchGatewayAuth).toHaveBeenNthCalledWith(2, {
      gatewayId: "eggman-devdays",
      allowLegacyFallback: true,
      skipCache: true,
    });
    expect(deps.persistGatewayDeviceToken).toHaveBeenCalledWith({
      token: "replacement-device-token",
    });
    const openCalls = vi.mocked(deps.openUpstream).mock.calls;
    expect(openCalls).toHaveLength(3);
    expect(openCalls[2]?.[0].identity).toBe(openCalls[0]?.[0].identity);
  });

  it("invalidates cached legacy auth before retrying an auth failure", async () => {
    const deps = depsForTest();
    const enrollment = fakeSocket("shared-token-enrollment");
    const recovered = fakeSocket("recovered");
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "legacy-token", token: "stale-legacy-token" })
      .mockResolvedValueOnce({ source: "legacy-token", token: "fresh-legacy-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("auth-failed", "unauthorized"))
      .mockResolvedValueOnce(enrollment)
      .mockImplementationOnce(async (params) => {
        await params.onDeviceToken?.({ deviceToken: "replacement-device-token" });
        return recovered;
      });

    await expect(openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
    }, deps)).resolves.toBe(recovered);

    expect(deps.invalidateGatewayToken).toHaveBeenCalledWith("default");
    expect(deps.clearGatewayDeviceToken).not.toHaveBeenCalled();
  });

  it("does not rotate credentials for a non-authentication failure", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "device-token-file", deviceToken: "device-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("timeout", "connect timed out"));

    await expect(openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
    }, deps)).rejects.toMatchObject({ code: "timeout" });

    expect(deps.fetchGatewayAuth).toHaveBeenCalledTimes(1);
    expect(deps.clearGatewayDeviceToken).not.toHaveBeenCalled();
    expect(deps.invalidateGatewayToken).not.toHaveBeenCalled();
  });

  it("surfaces a second authentication failure after one rotation attempt", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth)
      .mockResolvedValueOnce({ source: "device-token-file", deviceToken: "stale-device-token" })
      .mockResolvedValueOnce({ source: "legacy-token", token: "legacy-token" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValue(new OpenclawWireError("auth-failed", "unauthorized"));

    await expect(openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
    }, deps)).rejects.toMatchObject({ code: "auth-failed" });

    expect(deps.fetchGatewayAuth).toHaveBeenCalledTimes(2);
    expect(deps.openUpstream).toHaveBeenCalledTimes(2);
  });

  it("connects with the edge service identity and no pairing when the gateway trusts the proxy", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({ source: "trusted-proxy" });
    vi.mocked(deps.openUpstream).mockResolvedValue(fakeSocket("proxy"));
    vi.stubEnv("API_PUBLIC_URL", "https://api-test.octogee.com");

    const ws = await openAuthenticatedUpstream({
      gatewayId: "default",
      url: "http://127.0.0.1:18789",
      pairingUrl: "http://127.0.0.1:18789",
      timeoutMs: 5_000,
    }, deps);

    expect(ws).toEqual(expect.objectContaining({ label: "proxy" }));
    expect(deps.openUpstream).toHaveBeenCalledTimes(1);
    const params = vi.mocked(deps.openUpstream).mock.calls[0]![0];
    expect(params.proxyIdentity?.headers).toMatchObject({
      "x-octogee-user": "svc:gateway-edge",
      "x-octogee-proxy": "1",
      "x-forwarded-for": "10.128.0.75",
      origin: "https://api-test.octogee.com",
    });
    expect(params.token).toBeUndefined();
    expect(params.deviceToken).toBeUndefined();
    expect(params.bootstrapToken).toBeUndefined();
    expect(deps.requestDevicePairBootstrapToken).not.toHaveBeenCalled();
    expect(deps.persistGatewayDeviceToken).not.toHaveBeenCalled();
  });

  it("refuses a service identity connect when no attributable client address exists", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({ source: "trusted-proxy" });
    deps.serviceClientAddress = vi.fn(() => undefined);
    await expect(openAuthenticatedUpstream({ gatewayId: "default", url: "http://127.0.0.1:18789" }, deps))
      .rejects.toThrow("non-loopback IPv4 address");
    expect(deps.openUpstream).not.toHaveBeenCalled();
  });

  it("retries a proxy-identity connect without clearing any device or legacy credential", async () => {
    const deps = depsForTest();
    vi.mocked(deps.fetchGatewayAuth).mockResolvedValue({ source: "trusted-proxy" });
    vi.mocked(deps.openUpstream)
      .mockRejectedValueOnce(new OpenclawWireError("auth-failed", "unauthorized"))
      .mockResolvedValueOnce(fakeSocket("proxy-retry"));

    await openAuthenticatedUpstream({ gatewayId: "default", url: "http://127.0.0.1:18789" }, deps);

    expect(deps.clearGatewayDeviceToken).not.toHaveBeenCalled();
    expect(deps.invalidateGatewayToken).not.toHaveBeenCalled();
    expect(deps.openUpstream).toHaveBeenCalledTimes(2);
  });
});
