import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  openUpstream,
  requestDevicePairBootstrapToken,
} from "./upstream.js";
import {
  buildDeviceAuthPayloadV3,
  generateIdentity,
} from "@octogee/shared/types/device-identity";

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
    "base64",
  );
}

function verifyConnectSignature(params: any, identity: ReturnType<typeof generateIdentity>, token: string): boolean {
  const payload = buildDeviceAuthPayloadV3({
    deviceId: params.device.id,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: params.device.signedAt,
    token,
    nonce: params.device.nonce,
    platform: params.client.platform,
    deviceFamily: null,
  });
  return crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    crypto.createPublicKey(identity.publicKeyPem),
    decodeBase64Url(params.device.signature),
  );
}

async function withMockGateway<T>(
  fn: (url: string, captured: { params: any; setupParams: any; upgradeHeaders: any }) => Promise<T>,
  opts: {
    helloAuth?: Record<string, unknown>;
    setupResult?: (url: string) => Record<string, unknown>;
  } = {},
): Promise<T> {
  const wss = new WebSocketServer({ port: 0 });
  const captured = { params: null as any, setupParams: null as any, upgradeHeaders: null as any };
  let gatewayUrl = "";

  wss.on("connection", (ws: WebSocket, req) => {
    captured.upgradeHeaders = req.headers;
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-1" } }));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame?.method === "device.pair.setupCode" && opts.setupResult) {
        captured.setupParams = frame.params;
        ws.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: opts.setupResult(gatewayUrl),
        }));
        return;
      }
      if (frame?.method !== "connect") return;
      captured.params = frame.params;
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
            ...(opts.helloAuth ? { auth: opts.helloAuth } : {}),
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  gatewayUrl = `ws://127.0.0.1:${port}`;
  try {
    return await fn(gatewayUrl, captured);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

describe("openUpstream OpenClaw auth", () => {
  it("refuses to mint a device bootstrap credential through a non-loopback upstream", async () => {
    const ws = { send: vi.fn() } as unknown as WebSocket;

    await expect(requestDevicePairBootstrapToken({
      ws,
      url: "wss://gateway.example",
      timeoutMs: 30_000,
    })).rejects.toMatchObject({ code: "connect-failed" });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("uses auth.bootstrapToken and signs the one-time pairing reconnect with it", async () => {
    const identity = generateIdentity();
    await withMockGateway(async (url, captured) => {
      const ws = await openUpstream({
        url,
        bootstrapToken: "one-time-bootstrap-token",
        identity,
        timeoutMs: 30_000,
      });
      ws.close();

      expect(captured.params?.auth).toEqual({
        bootstrapToken: "one-time-bootstrap-token",
      });
      expect(verifyConnectSignature(captured.params, identity, "one-time-bootstrap-token"))
        .toBe(true);
    });
  });

  it("requests a full-access loopback setup and extracts only its one-time bootstrap token", async () => {
    const identity = generateIdentity();
    await withMockGateway(
      async (url, captured) => {
        const ws = await openUpstream({
          url,
          token: "shared-gateway-token",
          identity,
          timeoutMs: 30_000,
        });
        const bootstrapToken = await requestDevicePairBootstrapToken({
          ws,
          url: url.replace(/^ws:/u, "http:"),
          timeoutMs: 30_000,
        });
        ws.close();

        expect(bootstrapToken).toBe("one-time-bootstrap-token");
        expect(captured.setupParams).toEqual({
          publicUrl: url,
          includeQr: false,
        });
      },
      {
        setupResult: (url) => {
          const expiresAtMs = Date.now() + 60_000;
          return {
            setupId: "setup-1",
            setupCode: Buffer.from(JSON.stringify({
              url,
              bootstrapToken: "one-time-bootstrap-token",
              expiresAtMs,
            }), "utf8").toString("base64url"),
            gatewayUrl: url,
            auth: "token",
            urlSource: "request.publicUrl",
            access: "full",
            expiresAtMs,
          };
        },
      },
    );
  });

  it("uses auth.deviceToken and signs with the device token when provided", async () => {
    const identity = generateIdentity();
    await withMockGateway(async (url, captured) => {
      const ws = await openUpstream({
        url,
        deviceToken: "device-token-abc123",
        identity,
        timeoutMs: 30_000,
      });
      ws.close();

      expect(captured.params?.auth).toEqual({ deviceToken: "device-token-abc123" });
      expect(captured.params?.auth?.token).toBeUndefined();
      expect(captured.params?.scopes).toEqual([
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.questions",
        "operator.pairing",
      ]);
      expect(verifyConnectSignature(captured.params, identity, "device-token-abc123")).toBe(true);
    });
  });

  it("surfaces an issued device token from hello-ok for sidecar-local persistence", async () => {
    const identity = generateIdentity();
    const issued: unknown[] = [];
    await withMockGateway(
      async (url) => {
        const ws = await openUpstream({
          url,
          token: "legacy-token",
          identity,
          timeoutMs: 30_000,
          onDeviceToken: (auth) => { issued.push(auth); },
        });
        ws.close();
      },
      {
        helloAuth: {
          deviceToken: "issued-device-token",
          role: "operator",
          scopes: ["operator.admin"],
        },
      },
    );

    expect(issued).toEqual([
      {
        deviceToken: "issued-device-token",
        role: "operator",
        scopes: ["operator.admin"],
      },
    ]);
  });

  it("carries a proxy identity on the upgrade and uses backend mode to exclude service RPC from Online without self-declared authority", async () => {
    const identity = generateIdentity();
    await withMockGateway(async (url, captured) => {
      const ws = await openUpstream({
        url,
        identity,
        timeoutMs: 30_000,
        proxyIdentity: {
          headers: { "x-octogee-user": "svc:gateway-edge", "x-octogee-proxy": "1" },
        },
      });
      ws.close();

      expect(captured.upgradeHeaders["x-octogee-user"]).toBe("svc:gateway-edge");
      expect(captured.upgradeHeaders["x-octogee-proxy"]).toBe("1");
      expect(captured.params?.client).toMatchObject({ id: "openclaw-control-ui", mode: "backend" });
      expect(captured.params?.role).toBe("operator");
      expect(captured.params).not.toHaveProperty("auth");
      expect(captured.params).not.toHaveProperty("device");
      expect(captured.params).not.toHaveProperty("scopes");
    });
  });
});
