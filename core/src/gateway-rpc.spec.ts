import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import { createServer as createHttpServer } from "node:http";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import {
  OpenclawWireError,
  createGatewayRpc,
  provisionDefaultAgentAutomation,
  isAgentAlreadyExistsRpcError,
  isAgentDeletionPendingRpcError,
  isAgentNotFoundRpcError,
  type ConnectTrace,
  type CronAddSpec,
  type GatewayRpcClient,
} from "./gateway-rpc.js";
import type { DeviceIdentity } from "./gateway-device-identity.js";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, networkInterfaces: vi.fn(original.networkInterfaces) };
});

function makeTestIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const raw = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawKey = raw.length === 44 ? raw.subarray(12) : raw;
  const deviceId = crypto.createHash("sha256").update(rawKey).digest("hex");
  return { deviceId, publicKeyPem, privateKeyPem };
}

type RpcResponse = { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } };
type RpcHandler = (
  params: unknown,
  ws: WebSocket,
) => RpcResponse | Promise<RpcResponse>;

interface MockServerHandle {
  port: number;
  url: string;
  setHandler: (method: string, handler: RpcHandler) => void;
  
  setConnectHandler: (
    handler: (params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } },
  ) => void;
  
  setRejectAllAsAuth: (enabled: boolean) => void;
  
  callCount: (method: string) => number;
  lastUpgradeHeaders: () => Record<string, unknown> | null;
  disconnectClients: () => Promise<void>;
  close: () => Promise<void>;
}

async function startMockGateway(): Promise<MockServerHandle> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const handlers = new Map<string, RpcHandler>();
  const counts = new Map<string, number>();
  let connectHandler: ((params: unknown) => { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } }) | null = null;
  let rejectAuth = false;

  let lastUpgradeHeaders: Record<string, unknown> | null = null;

  wss.on("connection", (ws: WebSocket, req) => {
    lastUpgradeHeaders = { ...req.headers };

const nonce = crypto.randomBytes(12).toString("hex");
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce } }));
    ws.on("message", async (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame?.type !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") {
        return;
      }
      counts.set(frame.method, (counts.get(frame.method) ?? 0) + 1);

      if (frame.method === "connect") {
        if (rejectAuth) {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "UNAUTHENTICATED", message: "bad token" } }));
          return;
        }
        if (connectHandler) {
          const out = connectHandler(frame.params);
          ws.send(
            JSON.stringify(
              out.ok
                ? { type: "res", id: frame.id, ok: true, payload: out.payload }
                : { type: "res", id: frame.id, ok: false, error: out.error },
            ),
          );
          return;
        }
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
              policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 1000 },
            },
          }),
        );
        return;
      }

      const handler = handlers.get(frame.method);
      if (!handler) {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "NOT_FOUND", message: `no handler for ${frame.method}` },
          }),
        );
        return;
      }
      const out = await handler(frame.params, ws);
      ws.send(
        JSON.stringify(
          out.ok
            ? { type: "res", id: frame.id, ok: true, payload: out.payload }
            : { type: "res", id: frame.id, ok: false, error: out.error },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    setHandler: (method, handler) => handlers.set(method, handler),
    lastUpgradeHeaders: () => lastUpgradeHeaders,
    setConnectHandler: (handler) => {
      connectHandler = handler;
    },
    setRejectAllAsAuth: (enabled) => {
      rejectAuth = enabled;
    },
    callCount: (method) => counts.get(method) ?? 0,
    disconnectClients: async () => {
      await Promise.all(
        [...wss.clients].map(
          (client) => new Promise<void>((resolve) => {
            client.once("close", resolve);
            client.close();
          }),
        ),
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        
        for (const c of wss.clients) {
          try {
            c.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => resolve());
      }),
  };
}

async function startPhasedGateway(delays: { upgrade: number; challenge: number; connect: number }) {
  const http = createHttpServer();
  const wss = new WebSocketServer({ noServer: true });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sockets = new Set<import("node:net").Socket>();
  const methods: string[] = [];
  let markClosed: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const later = (ms: number, callback: () => void) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
    timers.add(timer);
  };
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); markClosed(); });
  });
  http.on("upgrade", (request, socket, head) => {
    later(delays.upgrade, () => {
      if (!socket.destroyed) wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
    });
  });
  wss.on("connection", (ws) => {
    later(delays.challenge, () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "phase-nonce" } }));
    });
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { id: string; method: string };
      methods.push(frame.method);
      later(frame.method === "connect" ? delays.connect : 0, () => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: frame.method === "connect"
          ? { type: "hello-ok", protocol: 4 }
          : { config: {}, hash: "persisted-P", configRevisionHash: "resolved-R", appliedConfigHash: "resolved-R" } }));
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
    methods,
    closed,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
    },
  };
}

describe("gateway-rpc", () => {
  let server: MockServerHandle;
  let client: GatewayRpcClient;

  beforeEach(async () => {
    server = await startMockGateway();
    client = createGatewayRpc({
      url: server.url,
      token: "test-token",
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  describe("configPatch", () => {
    function serveRevision(hash: string, applied: () => string | null = () => "resolved-R") {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: { config: {}, hash, configRevisionHash: "resolved-R", appliedConfigHash: applied() },
      }));
    }

    it.each([
      { delays: { upgrade: 3_000, challenge: 0, connect: 0 }, stage: "ws-open", methods: [] },
      { delays: { upgrade: 50, challenge: 3_000, connect: 0 }, stage: "challenge", methods: [] },
      { delays: { upgrade: 50, challenge: 50, connect: 3_000 }, stage: "connect", methods: ["connect"] },
    ])("shares the patch deadline across delayed connection phases and closes during $stage", async ({ delays, stage, methods }) => {
      const phased = await startPhasedGateway(delays);
      const traces: ConnectTrace[] = [];
      const bounded = createGatewayRpc({
        url: phased.url, token: "test-token", identity: makeTestIdentity(),
        connectTimeoutMs: 3_000, callTimeoutMs: 600, onConnectTrace: (trace) => traces.push(trace),
      });
      try {
        await expect(bounded.configPatchAndWaitForChange({}, "base-hash")).rejects.toBeInstanceOf(OpenclawWireError);
        expect(traces).toEqual([expect.objectContaining({ success: false, stage })]);
        expect(traces[0].totalMs).toBeLessThan(1_500);
        await phased.closed;
        expect(phased.methods).toEqual(methods);
      } finally {
        await bounded.close();
        await phased.close();
      }
    });

    it("keeps per-phase connection limits for callers without an overall deadline", async () => {
      const phased = await startPhasedGateway({ upgrade: 100, challenge: 100, connect: 200 });
      const traces: ConnectTrace[] = [];
      const ordinary = createGatewayRpc({
        url: phased.url, token: "test-token", identity: makeTestIdentity(),
        connectTimeoutMs: 500, callTimeoutMs: 300, onConnectTrace: (trace) => traces.push(trace),
      });
      try {
        await expect(ordinary.configGet()).resolves.toMatchObject({ hash: "persisted-P" });
        expect(traces).toEqual([expect.objectContaining({ success: true, stage: "done" })]);
        expect(phased.methods).toEqual(["connect", "config.get"]);
        await phased.closed;
      } finally {
        await ordinary.close();
        await phased.close();
      }
    });

    it("confirms the accepted persisted revision is applied without config.changed", async () => {
      server.setHandler("config.patch", () => ({
        ok: true,
        payload: { ok: true, hash: "persisted-P", path: "/fake/openclaw.json" },
      }));
      server.setHandler("config.get", () => ({
        ok: true,
        payload: {
          config: {},
          hash: "persisted-P",
          configRevisionHash: "resolved-R",
          appliedConfigHash: "resolved-R",
        },
      }));

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).resolves.toMatchObject({ hash: "persisted-P" });
      expect(server.callCount("config.patch")).toBe(1);
      expect(server.callCount("config.get")).toBe(1);
    });

    it("authenticates the config-change connection with the configured token", async () => {
      serveRevision("authenticated-hash");
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
          },
        };
      });
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "config.changed",
          payload: { hash: "authenticated-hash" },
        }));
        return {
          ok: true,
          payload: { ok: true, hash: "authenticated-hash", path: "/fake/openclaw.json" },
        };
      });

      await client.configPatchAndWaitForChange({ bindings: [] }, "base-hash");

      expect(captured?.auth).toEqual({ token: "test-token" });
    });

    it("uses a matching config.changed to check the authoritative applied revision", async () => {
      const events: string[] = [];
      let applied = false;
      serveRevision("accepted-hash", () => applied ? "resolved-R" : null);
      server.setHandler("config.patch", (_params, ws) => {
        events.push("patch-response");
        setTimeout(() => {
          events.push("config-changed");
          applied = true;
          ws.send(JSON.stringify({
            type: "event",
            event: "config.changed",
            payload: { hash: "accepted-hash" },
          }));
        }, 10);
        return {
          ok: true,
          payload: { ok: true, hash: "accepted-hash", path: "/fake/openclaw.json" },
        };
      });

      await client.configPatchAndWaitForChange({ bindings: [] }, "base-hash");

      expect(events).toEqual(["patch-response", "config-changed"]);
    });

    it("captures config.changed that arrives before the patch response", async () => {
      serveRevision("early-hash");
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "config.changed",
          payload: { hash: "early-hash" },
        }));
        return {
          ok: true,
          payload: { ok: true, hash: "early-hash", path: "/fake/openclaw.json" },
        };
      });

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).resolves.toMatchObject({ hash: "early-hash" });
    });

    it("ignores unrelated config.changed events while waiting for its persisted hash", async () => {
      const accepted: string[] = [];
      let applied = false;
      serveRevision("our-hash", () => applied ? "resolved-R" : null);
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({
          type: "event",
          event: "config.changed",
          payload: { hash: "someone-else" },
        }));
        setTimeout(() => {
          accepted.push("ours");
          applied = true;
          ws.send(JSON.stringify({
            type: "event",
            event: "config.changed",
            payload: { hash: "our-hash" },
          }));
        }, 10);
        return {
          ok: true,
          payload: { ok: true, hash: "our-hash", path: "/fake/openclaw.json" },
        };
      });

      await client.configPatchAndWaitForChange({ bindings: [] }, "base-hash");

      expect(accepted).toEqual(["ours"]);
    });

    it("observes delayed application without a config.changed event", async () => {
      client = createGatewayRpc({ url: server.url, token: "test-token", identity: makeTestIdentity(), callTimeoutMs: 1_500 });
      let reads = 0;
      serveRevision("persisted-P", () => ++reads === 1 ? null : "resolved-R");
      server.setHandler("config.patch", () => ({ ok: true, payload: { ok: true, hash: "persisted-P" } }));

      await expect(client.configPatchAndWaitForChange({}, "base-hash")).resolves.toMatchObject({ hash: "persisted-P" });
      expect(reads).toBe(2);
      expect(server.callCount("config.patch")).toBe(1);
    });

    it.each(["base-hash", "newer-persisted-hash"])("rejects another persisted revision even when its runtime is applied: %s", async (hash) => {
      serveRevision(hash);
      server.setHandler("config.patch", () => ({ ok: true, payload: { ok: true, hash: "persisted-P" } }));

      await expect(client.configPatchAndWaitForChange({}, "base-hash")).rejects.toMatchObject({ code: "hash-mismatch" });
    });

    it.each([null, "older-resolved-revision"])("does not accept a matching event with an unapplied revision: %s", async (applied) => {
      serveRevision("persisted-P", () => applied);
      server.setHandler("config.patch", (_params, ws) => {
        ws.send(JSON.stringify({ type: "event", event: "config.changed", payload: { hash: "persisted-P" } }));
        return { ok: true, payload: { ok: true, hash: "persisted-P" } };
      });

      await expect(client.configPatchAndWaitForChange({}, "base-hash")).rejects.toMatchObject({ code: "timeout" });
    });

    it.each([
      { configRevisionHash: "", appliedConfigHash: "" },
      { configRevisionHash: null, appliedConfigHash: null },
      { configRevisionHash: "resolved-R", appliedConfigHash: "" },
    ])("rejects invalid authoritative revision metadata: %j", async (revision) => {
      server.setHandler("config.patch", () => ({ ok: true, payload: { ok: true, hash: "persisted-P" } }));
      server.setHandler("config.get", () => ({ ok: true, payload: { hash: "persisted-P", ...revision } }));

      await expect(client.configPatchAndWaitForChange({}, "base-hash")).rejects.toMatchObject({ code: "invalid-response" });
    });

    it("rejects an authoritative read error without writing again", async () => {
      server.setHandler("config.patch", () => ({ ok: true, payload: { ok: true, hash: "persisted-P" } }));
      server.setHandler("config.get", () => ({ ok: false, error: { code: "UNAVAILABLE", message: "revision unavailable" } }));

      await expect(client.configPatchAndWaitForChange({}, "base-hash")).rejects.toMatchObject({ code: "rpc-error", message: "revision unavailable" });
      expect(server.callCount("config.patch")).toBe(1);
    });

    it("rejects a connection close while the accepted revision remains unapplied", async () => {
      server.setHandler("config.patch", () => ({ ok: true, payload: { ok: true, hash: "persisted-P" } }));
      server.setHandler("config.get", (_params, ws) => {
        setImmediate(() => ws.close());
        return { ok: true, payload: { hash: "persisted-P", configRevisionHash: "resolved-R", appliedConfigHash: null } };
      });

      await expect(client.configPatchAndWaitForChange({}, "base-hash")).rejects.toMatchObject({ code: "connect-failed" });
    });

    it("does not accept application after the original overall request budget", async () => {
      const startedAt = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
      server.setHandler("config.patch", () => {
        now.mockReturnValue(startedAt + 400);
        return { ok: true, payload: { ok: true, hash: "persisted-P" } };
      });
      server.setHandler("config.get", () => {
        now.mockReturnValue(startedAt + 501);
        return { ok: true, payload: { hash: "persisted-P", configRevisionHash: "resolved-R", appliedConfigHash: "resolved-R" } };
      });

      try {
        await expect(client.configPatchAndWaitForChange({}, "base-hash")).rejects.toMatchObject({ code: "timeout" });
      } finally {
        now.mockRestore();
      }
    });

    it("returns a no-op patch without waiting for an acceptance event", async () => {
      server.setHandler("config.patch", () => ({
        ok: true,
        payload: { ok: true, noop: true, path: "/fake/openclaw.json" },
      }));

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).resolves.toMatchObject({ noop: true });
    });

    it("rejects a changed patch without the acceptance hash", async () => {
      server.setHandler("config.patch", () => ({
        ok: true,
        payload: { ok: true, path: "/fake/openclaw.json" },
      }));

      await expect(
        client.configPatchAndWaitForChange({ bindings: [] }, "base-hash"),
      ).rejects.toMatchObject({
        code: "invalid-response",
        message: expect.stringContaining("missing `hash`"),
      });
    });

    it("sends a JSON-RPC request with raw + baseHash and returns the server payload on success", async () => {
      let captured: any;
      server.setHandler("config.patch", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            ok: true,
            noop: false,
            path: "/fake/openclaw.json",
            config: { channels: { mattermost: { accounts: { "x-coach": { botToken: "***" } } } } },
          },
        };
      });

      const patch = { channels: { mattermost: { accounts: { "x-coach": { botToken: "tok" } } } } };
      const result = await client.configPatch(patch, "deadbeef");

      expect(captured.baseHash).toBe("deadbeef");
      expect(JSON.parse(captured.raw)).toEqual(patch);
      expect(result.ok).toBe(true);
      expect(result.noop).toBe(false);
      expect(result.config).toEqual({ channels: { mattermost: { accounts: { "x-coach": { botToken: "***" } } } } });
    });

    it("includes replacePaths in the wire params when provided; omits the key otherwise", async () => {
      const capturedParams: any[] = [];
      server.setHandler("config.patch", (params) => {
        capturedParams.push(params);
        return { ok: true, payload: { ok: true, path: "/fake/openclaw.json" } };
      });

      await client.configPatch({ bindings: [] }, "h1", {
        replacePaths: ["bindings", "channels.mattermost.accounts.alice-coach.groupAllowFrom"],
      });
      expect(capturedParams[0].replacePaths).toEqual([
        "bindings",
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      ]);

      await client.configPatch({ bindings: [] }, "h1");
      expect(capturedParams[1]).not.toHaveProperty("replacePaths");

      await client.configPatch({ bindings: [] }, "h1", { replacePaths: [] });
      expect(capturedParams[2]).not.toHaveProperty("replacePaths");
    });

    it("throws OpenclawWireError with 'hash-mismatch' code when the server rejects the base hash", async () => {
      server.setHandler("config.patch", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "config changed since last load; re-run config.get and retry" },
      }));

      await expect(client.configPatch({}, "stalehash")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "hash-mismatch",
      });
    });

    it("throws OpenclawWireError with 'invalid-patch' code on a validation error", async () => {
      server.setHandler("config.patch", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid config: channels.mattermost.accounts.x-coach.botToken must be a string" },
      }));

      await expect(client.configPatch({}, "hash")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-patch",
      });
    });
  });

  describe("configApply", () => {
    it("sends the complete config as raw JSON with its base hash", async () => {
      let captured: any;
      server.setHandler("config.apply", (params) => {
        captured = params;
        return { ok: true, payload: { ok: true, path: "/fake/openclaw.json" } };
      });

      const config = {
        agents: {
          list: [
            { id: "octogee-bob-coach", memorySearch: { apiKey: { source: "env", id: "BOB" } } },
          ],
        },
      };
      const result = await client.configApply(config, "current-hash");

      expect(captured).toEqual({ raw: JSON.stringify(config), baseHash: "current-hash" });
      expect(result.ok).toBe(true);
    });

    it("maps stale base-hash and invalid-config errors to stable wire codes", async () => {
      server.setHandler("config.apply", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "config changed since last load" },
      }));
      await expect(client.configApply({}, "stale")).rejects.toMatchObject({
        code: "hash-mismatch",
      });

      server.setHandler("config.apply", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid config: agents.list" },
      }));
      await expect(client.configApply({}, "current")).rejects.toMatchObject({
        code: "invalid-patch",
      });
    });
  });

  describe("modelsAuthRefresh", () => {
    it("refreshes the selected agent's native auth snapshot", async () => {
      let captured: unknown;
      server.setHandler("models.authRefresh", params => {
        captured = params;
        return { ok: true, payload: { refreshed: true } };
      });

      await expect(client.modelsAuthRefresh({ agentId: "octogee-a-coach" })).resolves.toEqual({ refreshed: true });
      expect(captured).toEqual({ agentId: "octogee-a-coach" });
    });

    it.each([null, {}, { refreshed: false }])("rejects an unacknowledged refresh: %j", async payload => {
      server.setHandler("models.authRefresh", () => ({ ok: true, payload }));
      await expect(client.modelsAuthRefresh({ agentId: "octogee-a-coach" })).rejects.toMatchObject({ code: "invalid-response" });
    });
  });

  describe("gatewayRestartRequest", () => {
    it("requests a safe gateway restart through the OpenClaw RPC", async () => {
      let captured: any;
      server.setHandler("gateway.restart.request", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            ok: true,
            status: "scheduled",
            restart: {
              ok: true,
              pid: 123,
              signal: "SIGUSR2",
              coalesced: false,
            },
          },
        };
      });

      const result = await client.gatewayRestartRequest({
        reason: "byosub.oauth-runtime",
        skipDeferral: true,
      });

      expect(captured).toEqual({
        reason: "byosub.oauth-runtime",
        skipDeferral: true,
      });
      expect(result).toEqual({
        ok: true,
        status: "scheduled",
        restart: {
          ok: true,
          pid: 123,
          signal: "SIGUSR2",
          coalesced: false,
        },
      });
    });

    it("rejects a legacy SIGUSR1 restart acknowledgement", async () => {
      server.setHandler("gateway.restart.request", () => ({
        ok: true,
        payload: {
          ok: true,
          status: "scheduled",
          restart: { ok: true, pid: 123, signal: "SIGUSR1", coalesced: false },
        },
      }));

      await expect(
        client.gatewayRestartRequest({ reason: "routing", skipDeferral: true }),
      ).rejects.toMatchObject({
        code: "invalid-response",
        message: expect.stringContaining("malformed restart acknowledgement"),
      });
    });

    it("rejects a non-causal restart acknowledgement", async () => {
      server.setHandler("gateway.restart.request", () => ({
        ok: true,
        payload: { status: "requested" },
      }));

      await expect(
        client.gatewayRestartRequest({ reason: "routing", skipDeferral: true }),
      ).rejects.toMatchObject({
        code: "invalid-response",
        message: expect.stringContaining("malformed restart acknowledgement"),
      });
    });
  });

  describe("scheduler migration protocol", () => {
    it("carries the exact native scheduler command and private export snapshot", async () => {
      const request = { operationId: "move-1", phase: "export" as const };
      const result = { ...request, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { jobs: [] } };
      server.setHandler("cron.migration", (params) => {
        expect(params).toEqual(request);
        return { ok: true, payload: result };
      });
      await expect(client.schedulerMigration(request)).resolves.toEqual(result);
    });
    it.each([{}, { operationId: "wrong", phase: "hold", agentIds: [], drained: true }, { operationId: "move-1", phase: "export", agentIds: [], drained: true }])("refuses invalid native acknowledgements %j", async (payload) => {
      server.setHandler("cron.migration", () => ({ ok: true, payload }));
      await expect(client.schedulerMigration({ operationId: "move-1", phase: "export" })).rejects.toMatchObject({ code: "invalid-response" });
    });
  });

  describe("scheduled migration eligibility", () => {
    it("counts enabled jobs for the exact agent without fetching prompts", async () => {
      server.setHandler("cron.list", (params) => {
        expect(params).toEqual({ agentId: "octogee-alice-coach", enabled: "enabled", compact: true, limit: 1 });
        return { ok: true, payload: { total: 2, jobs: [{ id: "job" }] } };
      });
      await expect(client.cronJobCount("octogee-alice-coach")).resolves.toBe(2);
    });
    it("counts disabled jobs too when asked, by sending the explicit all filter", async () => {
      server.setHandler("cron.list", (params) => {
        expect(params).toEqual({ agentId: "octogee-alice-coach", enabled: "all", compact: true, limit: 1 });
        return { ok: true, payload: { total: 3, jobs: [{ id: "job" }] } };
      });
      await expect(
        client.cronJobCount("octogee-alice-coach", { includeDisabled: true }),
      ).resolves.toBe(3);
    });
    it.each([{}, { total: -1 }, { total: "0" }])("rejects unverified cron counts: %j", async (payload) => {
      server.setHandler("cron.list", () => ({ ok: true, payload }));
      await expect(client.cronJobCount("octogee-alice-coach")).rejects.toMatchObject({ code: "invalid-response" });
    });
  });

  describe("schedule transfer cron requests", () => {
    it.each(["cron.list", "cron.add", "cron.remove", "cron.scratch.get", "cron.scratch.set", "cron.update"] as const)("forwards %s with its params and returns the payload", async (method) => {
      const params = { id: "job-1", offset: 0 };
      server.setHandler(method, (received) => {
        expect(received).toEqual(params);
        return { ok: true, payload: { method } };
      });
      await expect(client.cronRequest(method, params)).resolves.toEqual({ method });
    });
    it("refuses any other method without calling the gateway", async () => {
      const handler = vi.fn<RpcHandler>(() => ({ ok: true, payload: {} }));
      server.setHandler("cron.migration", handler);
      await expect(client.cronRequest("cron.migration" as never, {})).rejects.toThrow("cron.migration");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("channels lifecycle", () => {
    it("stops and starts one Mattermost account through the channel RPC", async () => {
      const calls: Array<{ method: string; params: unknown }> = [];
      server.setHandler("channels.stop", (params) => {
        calls.push({ method: "channels.stop", params });
        return {
          ok: true,
          payload: { channel: "mattermost", accountId: "alice-coach", stopped: true },
        };
      });
      server.setHandler("channels.start", (params) => {
        calls.push({ method: "channels.start", params });
        return {
          ok: true,
          payload: { channel: "mattermost", accountId: "alice-coach", started: true },
        };
      });

      await expect(
        client.channelsStop({ channel: "mattermost", accountId: "alice-coach" }),
      ).resolves.toMatchObject({ stopped: true });
      await expect(
        client.channelsStart({ channel: "mattermost", accountId: "alice-coach" }),
      ).resolves.toMatchObject({ started: true });
      expect(calls).toEqual([
        {
          method: "channels.stop",
          params: { channel: "mattermost", accountId: "alice-coach" },
        },
        {
          method: "channels.start",
          params: { channel: "mattermost", accountId: "alice-coach" },
        },
      ]);
    });

    it("accepts a start acknowledgement while the channel is still becoming ready", async () => {
      server.setHandler("channels.start", () => ({
        ok: true,
        payload: { channel: "mattermost", accountId: "alice-coach", started: false },
      }));

      await expect(
        client.channelsStart({ channel: "mattermost", accountId: "alice-coach" }),
      ).resolves.toMatchObject({ started: false });
    });

    it("rejects a start acknowledgement without a boolean result", async () => {
      server.setHandler("channels.start", () => ({
        ok: true,
        payload: { channel: "mattermost", accountId: "alice-coach", started: "yes" },
      }));

      await expect(
        client.channelsStart({ channel: "mattermost", accountId: "alice-coach" }),
      ).rejects.toMatchObject({
        code: "invalid-response",
        message: expect.stringContaining("missing boolean `started`"),
      });
    });
  });

  describe("configGet", () => {
    it("returns the config snapshot and its hash", async () => {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: {
          valid: true,
          hash: "abc123",
          configRevisionHash: "revision-123",
          appliedConfigHash: "revision-123",
          config: { channels: { mattermost: {} } },
        },
      }));

      const { config, hash, configRevisionHash, appliedConfigHash } = await client.configGet();
      expect(hash).toBe("abc123");
      expect(configRevisionHash).toBe("revision-123");
      expect(appliedConfigHash).toBe("revision-123");
      expect(config).toEqual({ channels: { mattermost: {} } });
    });

    it("throws OpenclawWireError when the snapshot has no hash", async () => {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: {
          valid: true,
          configRevisionHash: "revision-123",
          appliedConfigHash: null,
          config: {},
        },
      }));

      await expect(client.configGet()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("rejects a snapshot without runtime application state", async () => {
      server.setHandler("config.get", () => ({
        ok: true,
        payload: { valid: true, hash: "abc123", config: {} },
      }));

      await expect(client.configGet()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
        message: expect.stringContaining("configRevisionHash"),
      });
    });
  });

  describe("sessions", () => {
    it("lists and resets the agent's runtime sessions through the official gateway API", async () => {
      server.setHandler("sessions.list", (params) => ({
        ok: true,
        payload: {
          sessions: [{ key: "agent:octogee-alice-coach:mattermost:group:channel", agentId: "octogee-alice-coach" }],
          ...params as object,
        },
      }));
      server.setHandler("sessions.reset", (params) => ({
        ok: true,
        payload: { ok: true, ...params as object },
      }));

      await expect(client.sessionsList({ agentId: "octogee-alice-coach" })).resolves.toEqual({
        sessions: [{ key: "agent:octogee-alice-coach:mattermost:group:channel", agentId: "octogee-alice-coach" }],
        agentId: "octogee-alice-coach",
      });
      await expect(
        client.sessionsReset({
          key: "agent:octogee-alice-coach:mattermost:group:channel",
          agentId: "octogee-alice-coach",
          reason: "reset",
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it("aborts a running session through sessions.abort and reports whether a run was stopped", async () => {
      let captured: unknown;
      server.setHandler("sessions.abort", (params) => {
        captured = params;
        return { ok: true, payload: { ok: true, abortedRunId: "run-7", status: "aborted" } };
      });

      await expect(client.sessionsAbort({
        key: "agent:octogee-alice-coach:mattermost:group:channel",
        agentId: "octogee-alice-coach",
        clearQueued: true,
      })).resolves.toEqual({ ok: true, abortedRunId: "run-7", status: "aborted" });
      expect(captured).toEqual({
        key: "agent:octogee-alice-coach:mattermost:group:channel",
        agentId: "octogee-alice-coach",
        clearQueued: true,
      });
    });

    it("rejects a sessions.abort acknowledgement without an abort status", async () => {
      server.setHandler("sessions.abort", () => ({ ok: true, payload: { ok: true } }));

      await expect(client.sessionsAbort({
        key: "agent:octogee-alice-coach:main",
        agentId: "octogee-alice-coach",
        clearQueued: true,
      })).rejects.toMatchObject({ name: "OpenclawWireError", code: "invalid-response" });
    });
  });

  describe("toolsCatalog", () => {
    it("requests the exact agent plugin catalog and validates the response", async () => {
      let captured: unknown;
      server.setHandler("tools.catalog", (params) => {
        captured = params;
        return {
          ok: true,
          payload: { agentId: "octogee-test-coach", groups: [] },
        };
      });

      await expect(client.toolsCatalog({
        agentId: "octogee-test-coach",
        includePlugins: true,
      })).resolves.toEqual({
        agentId: "octogee-test-coach",
        groups: [],
      });
      expect(captured).toEqual({
        agentId: "octogee-test-coach",
        includePlugins: true,
      });
    });

    it("rejects a catalog for a different agent", async () => {
      server.setHandler("tools.catalog", () => ({
        ok: true,
        payload: { agentId: "octogee-other-coach", groups: [] },
      }));

      await expect(client.toolsCatalog({
        agentId: "octogee-test-coach",
        includePlugins: true,
      })).rejects.toMatchObject({
        code: "invalid-response",
      });
    });
  });

  describe("cronAdd", () => {
    it("calls `cron.add` with the job spec verbatim and returns the server payload", async () => {
      let captured: unknown = "not-called";
      server.setHandler("cron.add", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            id: "job-abc",
            name: "test-job",
            createdAtMs: 1,
            updatedAtMs: 1,
            enabled: true,
            schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "hi" },
            state: {},
          },
        };
      });

      const job = {
        name: "test-job",
        agentId: "octogee-test-coach",
        enabled: true,
        deleteAfterRun: true,
        schedule: { kind: "at" as const, at: "2030-01-01T00:00:00Z" },
        sessionTarget: "isolated" as const,
        wakeMode: "now" as const,
        payload: { kind: "agentTurn" as const, message: "hi" },
        delivery: {
          mode: "announce" as const,
          channel: "mattermost" as const,
          accountId: "test-coach",
          bestEffort: true,
        },
      };
      const result = await client.cronAdd(job);

      expect(captured).toEqual(job);
      expect(result.id).toBe("job-abc");
    });

    it.each([true, false])("accepts native declaration convergence (created: %s)", async (created) => {
      server.setHandler("cron.add", () => ({
        ok: true,
        payload: { created, updated: false, job: { id: "coach-monitor", agentId: "octogee-test-coach" } },
      }));
      await expect(client.cronAdd({
        name: "Proactive check",
        declarationKey: "octogee:coach-monitor:octogee-test-coach",
        agentId: "octogee-test-coach",
        enabled: true,
        idleOnly: true,
        schedule: { kind: "every", everyMs: 1_800_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review your automation scratch checklist.", skipIfScratchEmpty: true },
        delivery: { mode: "announce", target: "owner" },
      })).resolves.toMatchObject({ id: "coach-monitor", created });
    });

    it.each([{ created: true, job: {} }, { created: false, job: "invalid" }])("rejects malformed native declaration result %#", async (payload) => {
      server.setHandler("cron.add", () => ({ ok: true, payload }));
      await expect(client.cronAdd({
        name: "Proactive check",
        enabled: true,
        schedule: { kind: "every", everyMs: 1_800_000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review the checklist." },
      })).rejects.toMatchObject({ code: "invalid-response" });
    });

    it("throws OpenclawWireError('invalid-response') if the server returns a non-object payload", async () => {
      server.setHandler("cron.add", () => ({ ok: true, payload: "boom" }));
      await expect(
        client.cronAdd({
          name: "x",
          enabled: true,
          schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
        }),
      ).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("surfaces server-side validation errors as 'rpc-error'", async () => {
      server.setHandler("cron.add", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "invalid cron.add params: schedule.at must be ISO" },
      }));
      await expect(
        client.cronAdd({
          name: "x",
          enabled: true,
          schedule: { kind: "at", at: "bogus" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hi" },
        }),
      ).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "rpc-error",
      });
    });
  });

  describe("channelsStatus", () => {
    it("reuses one authenticated connection across health polls", async () => {
      server.setHandler("channels.status", () => ({
        ok: true,
        payload: { channels: [] },
      }));

      await client.channelsStatus();
      await client.channelsStatus();

      expect(server.callCount("channels.status")).toBe(2);
      expect(server.callCount("connect")).toBe(1);
      expect(client.channelsStatusConnectionGeneration()).toBe(1);
    });

    it("reconnects after the health connection drops", async () => {
      server.setHandler("channels.status", () => ({
        ok: true,
        payload: { channels: [] },
      }));

      await client.channelsStatus();
      await server.disconnectClients();
      await client.channelsStatus();

      expect(server.callCount("channels.status")).toBe(2);
      expect(server.callCount("connect")).toBe(2);
      expect(client.channelsStatusConnectionGeneration()).toBe(2);
    });
  });

  describe("agentsDetach", () => {
    it("requests non-destructive detach without deletion flags", async () => {
      let captured: unknown;
      server.setHandler("agents.detach", params => { captured = params; return { ok: true, payload: { ok: true, agentId: "octogee-alice-coach", purgeFailed: false, failed: [] } }; });
      await expect(client.agentsDetach({ agentId: "octogee-alice-coach" })).resolves.toMatchObject({ ok: true });
      expect(captured).toEqual({ agentId: "octogee-alice-coach" });
    });
    it.each([{ purgeFailed: true }, { purgeFailed: "false" }, { purgeFailed: null }, { failed: [{}] }, { agentId: "other" }])("refuses unconfirmed detach: %j", async cleanup => {
      server.setHandler("agents.detach", () => ({ ok: true, payload: { ok: true, agentId: "octogee-alice-coach", ...cleanup } }));
      await expect(client.agentsDetach({ agentId: "octogee-alice-coach" })).rejects.toMatchObject({ code: "invalid-response" });
    });
  });

  describe("agentsDelete", () => {
    it.each([
      { purgeFailed: "true" }, { purgeFailed: null }, { purgeFailed: 0 },
      { failed: {} }, { failed: "" }, { failed: null }, { failed: 0 },
    ])("rejects malformed cleanup metadata: %j", async (cleanup) => {
      server.setHandler("agents.delete", () => ({
        ok: true, payload: { ok: true, agentId: "octogee-alice-coach", ...cleanup },
      }));
      await expect(client.agentsDelete({ agentId: "octogee-alice-coach" })).rejects.toMatchObject({
        name: "OpenclawWireError", code: "invalid-response",
      });
    });

    it.each([
      { purgeFailed: false, failed: [] },
      { purgeFailed: true, failed: [{ path: "/state/agent.sqlite", error: "held" }] },
    ])("preserves typed native cleanup metadata: %j", async (cleanup) => {
      server.setHandler("agents.delete", () => ({ ok: true, payload: { ok: true, ...cleanup } }));
      await expect(client.agentsDelete({ agentId: "octogee-alice-coach" })).resolves.toMatchObject(cleanup);
    });

    it("calls `agents.delete` with the agent id and returns the gateway payload", async () => {
      let captured: unknown = "not-called";
      server.setHandler("agents.delete", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            ok: true,
            agentId: "octogee-alice-coach",
            removedBindings: 2,
            removed: [{ path: "/state/agents/octogee-alice-coach", method: "trash" }],
            failed: [],
          },
        };
      });

      const result = await client.agentsDelete({ agentId: "octogee-alice-coach" });

      expect(captured).toEqual({ agentId: "octogee-alice-coach" });
      expect(result).toMatchObject({ ok: true, agentId: "octogee-alice-coach", removedBindings: 2 });
    });

    it("forwards deleteFiles when the caller pins it", async () => {
      let captured: unknown = "not-called";
      server.setHandler("agents.delete", (params) => {
        captured = params;
        return { ok: true, payload: { ok: true, agentId: "octogee-alice-coach", removedBindings: 0 } };
      });

      await client.agentsDelete({ agentId: "octogee-alice-coach", deleteFiles: false });

      expect(captured).toEqual({ agentId: "octogee-alice-coach", deleteFiles: false });
    });

    it("throws OpenclawWireError('invalid-response') when the payload is missing `ok: true`", async () => {
      server.setHandler("agents.delete", () => ({
        ok: true,
        payload: { agentId: "octogee-alice-coach" },
      }));

      await expect(client.agentsDelete({ agentId: "octogee-alice-coach" })).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("surfaces the gateway's not-found refusal as an rpc-error the caller can classify", async () => {
      server.setHandler("agents.delete", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: `agent "octogee-ghost-coach" not found` },
      }));

      const err = await client
        .agentsDelete({ agentId: "octogee-ghost-coach" })
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(OpenclawWireError);
      expect(isAgentNotFoundRpcError(err)).toBe(true);
    });

    it("does not classify an unrelated agents.delete refusal as not-found", async () => {
      server.setHandler("agents.delete", () => ({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `Agent "octogee-alice-coach" is the default and cannot be deleted. Reassign default first.`,
        },
      }));

      const err = await client
        .agentsDelete({ agentId: "octogee-alice-coach" })
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(OpenclawWireError);
      expect(isAgentNotFoundRpcError(err)).toBe(false);
    });
  });

  describe("agentsCreate", () => {
    it("returns on the persisted agents.create acknowledgement without waiting for config.changed", async () => {
      let captured: unknown = "not-called";
      server.setHandler("agents.create", (params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            ok: true,
            agentId: "octogee-alice-coach",
            name: "octogee-alice-coach",
            workspace: "/home/node/.openclaw/customers/alice",
          },
        };
      });

      const result = await client.agentsCreate({
        name: "octogee-alice-coach",
        workspace: "/home/node/.openclaw/customers/alice",
      });

      expect(captured).toEqual({
        name: "octogee-alice-coach",
        workspace: "/home/node/.openclaw/customers/alice",
      });
      expect(result).toMatchObject({
        ok: true,
        agentId: "octogee-alice-coach",
        workspace: "/home/node/.openclaw/customers/alice",
      });
    });

    it("throws OpenclawWireError('invalid-response') when the payload is missing `ok: true`", async () => {
      server.setHandler("agents.create", () => ({
        ok: true,
        payload: { agentId: "octogee-alice-coach" },
      }));

      await expect(
        client.agentsCreate({ name: "octogee-alice-coach", workspace: "/w" }),
      ).rejects.toMatchObject({ name: "OpenclawWireError", code: "invalid-response" });
    });

    it("throws OpenclawWireError('invalid-response') when the payload carries no agentId", async () => {
      server.setHandler("agents.create", () => ({
        ok: true,
        payload: { ok: true, name: "octogee-alice-coach" },
      }));

      await expect(
        client.agentsCreate({ name: "octogee-alice-coach", workspace: "/w" }),
      ).rejects.toMatchObject({ name: "OpenclawWireError", code: "invalid-response" });
    });

    it("surfaces the gateway's already-exists refusal as an rpc-error the caller can classify", async () => {
      server.setHandler("agents.create", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: `agent "octogee-alice-coach" already exists` },
      }));

      const err = await client
        .agentsCreate({ name: "octogee-alice-coach", workspace: "/w" })
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(OpenclawWireError);
      expect(isAgentAlreadyExistsRpcError(err)).toBe(true);
    });

    it("does not classify an unrelated agents.create refusal as already-exists", async () => {
      server.setHandler("agents.create", () => ({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "workspace path is outside the state dir" },
      }));

      const err = await client
        .agentsCreate({ name: "octogee-alice-coach", workspace: "/w" })
        .then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(OpenclawWireError);
      expect(isAgentAlreadyExistsRpcError(err)).toBe(false);
    });
  });

  describe("isAgentAlreadyExistsRpcError", () => {
    it("rejects non-wire errors and non-rpc wire codes so transport failures still fail loudly", () => {
      expect(isAgentAlreadyExistsRpcError(new Error(`agent "x" already exists`))).toBe(false);
      expect(
        isAgentAlreadyExistsRpcError(
          new OpenclawWireError("connect-failed", `agent "x" already exists`),
        ),
      ).toBe(false);
    });
  });

  describe("isAgentDeletionPendingRpcError", () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const pending = (id: string) =>
      new OpenclawWireError("rpc-error", `agent "${id}" deletion cleanup is still pending`);

    it("classifies the gateway's pending-deletion refusal of agents.create for that agent", () => {
      expect(isAgentDeletionPendingRpcError(pending(agentId), agentId)).toBe(true);
    });

    it("rejects a refusal naming a different agent, so the remedy never deletes the wrong one", () => {
      expect(isAgentDeletionPendingRpcError(pending("octogee-alice-coach"), agentId)).toBe(false);
    });

    it("rejects already-exists refusals, non-wire errors and non-rpc wire codes", () => {
      expect(
        isAgentDeletionPendingRpcError(
          new OpenclawWireError("rpc-error", `agent "${agentId}" already exists`),
          agentId,
        ),
      ).toBe(false);
      expect(
        isAgentDeletionPendingRpcError(
          new Error(`agent "${agentId}" deletion cleanup is still pending`),
          agentId,
        ),
      ).toBe(false);
      expect(
        isAgentDeletionPendingRpcError(
          new OpenclawWireError(
            "connect-failed",
            `agent "${agentId}" deletion cleanup is still pending`,
          ),
          agentId,
        ),
      ).toBe(false);
    });
  });

  describe("isAgentNotFoundRpcError", () => {
    it("rejects non-wire errors and non-rpc wire codes so transport failures still fail loudly", () => {
      expect(isAgentNotFoundRpcError(new Error(`agent "x" not found`))).toBe(false);
      expect(
        isAgentNotFoundRpcError(
          new OpenclawWireError("connect-failed", `agent "x" not found`),
        ),
      ).toBe(false);
    });
  });

  describe("recovery restart", () => {
    const CONFIG_RESTART_REQUIRED =
      "config.patch persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision";
    const AGENT_RESTART_REQUIRED =
      "Agent configuration was saved but its application to the active Gateway was not confirmed (applied-restart-required); run config.get, then apply the saved config or restart the Gateway.";
    const scheduled = {
      ok: true as const,
      payload: { ok: true, status: "scheduled", restart: { ok: true, pid: 123, signal: "SIGUSR2", coalesced: false } },
    };
    const unavailable = (message: string) => () => ({ ok: false as const, error: { code: "UNAVAILABLE", message } });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("requests a Gateway restart when a config write needs a recovery restart and still fails the write", async () => {
      let captured: unknown;
      server.setHandler("config.patch", unavailable(CONFIG_RESTART_REQUIRED));
      server.setHandler("gateway.restart.request", (params) => {
        captured = params;
        return scheduled;
      });

      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toMatchObject({
        code: "rpc-error",
        message: CONFIG_RESTART_REQUIRED,
      });
      expect(captured).toEqual({ reason: "octogee.recovery-restart-required" });
    });

    it("requests a Gateway restart when an agent write reports applied-restart-required", async () => {
      server.setHandler("agents.delete", unavailable(AGENT_RESTART_REQUIRED));
      server.setHandler("gateway.restart.request", () => scheduled);

      await expect(client.agentsDelete({ agentId: "octogee-alice-coach" })).rejects.toMatchObject({
        message: AGENT_RESTART_REQUIRED,
      });
      expect(server.callCount("gateway.restart.request")).toBe(1);
    });

    it("asks a Gateway for at most one recovery restart every ten minutes", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-02T00:00:00Z"));
      server.setHandler("config.patch", unavailable(CONFIG_RESTART_REQUIRED));
      server.setHandler("gateway.restart.request", () => scheduled);

      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toThrow();
      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toThrow();
      expect(server.callCount("gateway.restart.request")).toBe(1);

      vi.setSystemTime(new Date("2026-11-02T00:10:00Z"));
      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toThrow();
      expect(server.callCount("gateway.restart.request")).toBe(2);
    });

    it.each([true, false])("coalesces concurrent failures while restart success=%s is pending", async success => {
      let finish!: (response: RpcResponse) => void;
      const pending = new Promise<RpcResponse>(resolve => { finish = resolve; });
      server.setHandler("config.patch", unavailable(CONFIG_RESTART_REQUIRED));
      server.setHandler("gateway.restart.request", () => pending);
      const writes = Promise.allSettled([
        client.configPatch({ a: 1 }, "hash-1"),
        client.configPatch({ b: 2 }, "hash-1"),
      ]);
      await vi.waitFor(() => expect(server.callCount("config.patch")).toBe(2));
      await vi.waitFor(() => expect(server.callCount("gateway.restart.request")).toBeGreaterThan(0));
      finish(success ? scheduled : unavailable("restart admission closed")());
      const results = await writes;
      expect(results).toEqual([
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: CONFIG_RESTART_REQUIRED }) }),
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: CONFIG_RESTART_REQUIRED }) }),
      ]);
      expect(server.callCount("gateway.restart.request")).toBe(1);
      server.setHandler("gateway.restart.request", () => scheduled);
      await expect(client.configPatch({ c: 3 }, "hash-1")).rejects.toThrow(CONFIG_RESTART_REQUIRED);
      expect(server.callCount("gateway.restart.request")).toBe(success ? 1 : 2);
    });

    it("asks again on the next failure when the restart request itself failed", async () => {
      server.setHandler("config.patch", unavailable(CONFIG_RESTART_REQUIRED));
      server.setHandler("gateway.restart.request", unavailable("restart admission closed"));

      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toMatchObject({ message: CONFIG_RESTART_REQUIRED });
      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toMatchObject({ message: CONFIG_RESTART_REQUIRED });
      expect(server.callCount("gateway.restart.request")).toBe(2);
    });

    it.each([
      ["a starting Gateway", { code: "UNAVAILABLE", message: "gateway starting; retry shortly" }],
      ["a superseded reload", { code: "UNAVAILABLE", message: "config.patch persisted but was not applied to the active Gateway (superseded)" }],
      ["an invalid request naming the restart", { code: "INVALID_REQUEST", message: CONFIG_RESTART_REQUIRED }],
    ])("leaves %s alone", async (_label, error) => {
      server.setHandler("config.patch", () => ({ ok: false, error }));
      server.setHandler("gateway.restart.request", () => scheduled);

      await expect(client.configPatch({ a: 1 }, "hash-1")).rejects.toMatchObject({ message: error.message });
      expect(server.callCount("gateway.restart.request")).toBe(0);
    });
  });

  describe("brokerProfilesMaterialize", () => {
    it("submits only canonical agent identifiers to the owning Gateway", async () => {
      const params = { agentIds: ["octogee-alice-coach"] };
      server.setHandler("octogee.brokerProfiles.materialize", value => {
        expect(value).toEqual(params);
        return { ok: true, payload: { ok: true } };
      });
      await expect(client.brokerProfilesMaterialize(params)).resolves.toEqual({ ok: true });
      expect(server.callCount("octogee.brokerProfiles.materialize")).toBe(1);
    });

    it.each([null, {}, { ok: false }, { ok: "true" }])("rejects an unacknowledged profile write: %j", async payload => {
      server.setHandler("octogee.brokerProfiles.materialize", () => ({ ok: true, payload }));
      await expect(client.brokerProfilesMaterialize({ agentIds: ["octogee-alice-coach"] }))
        .rejects.toMatchObject({ code: "invalid-response" });
    });
  });

  describe("secretsReload", () => {
    it("calls the `secrets.reload` method with empty params and returns the payload", async () => {
      let captured: unknown = "not-called";
      server.setHandler("secrets.reload", (params) => {
        captured = params;
        return { ok: true, payload: { ok: true, warningCount: 0 } };
      });

      const result = await client.secretsReload();

expect(captured).toEqual({});
      expect(result.ok).toBe(true);
      expect(result.warningCount).toBe(0);
    });

    it("surfaces warningCount when the gateway reports unresolved refs", async () => {
      server.setHandler("secrets.reload", () => ({
        ok: true,
        payload: { ok: true, warningCount: 3 },
      }));
      const result = await client.secretsReload();
      expect(result.warningCount).toBe(3);
    });

    it("reads redacted degraded owners from native status without channel summary", async () => {
      let captured: unknown;
      const owners = [
  {
    "ownerKind": "capability",
    "ownerId": "memory-provider:octogee-bravo-proj-timer-coach",
    "state": "unavailable",
    "degradationState": "cold",
    "paths": [
      "agents.entries.octogee-bravo-proj-timer-coach.memory.search.remote.apiKey"
    ],
    "reason": "secret provider failed"
  },
  {
    "ownerKind": "account",
    "ownerId": "[\"/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent/openclaw-agent.sqlite\",\"anthropic:default\"]",
    "state": "unavailable",
    "degradationState": "cold",
    "paths": [
      "/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent.auth-profiles.anthropic:default.key"
    ],
    "reason": "secret provider failed"
  },
  {
    "ownerKind": "account",
    "ownerId": "[\"/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent/openclaw-agent.sqlite\",\"platform-openrouter:default\"]",
    "state": "unavailable",
    "degradationState": "cold",
    "paths": [
      "/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent.auth-profiles.platform-openrouter:default.key"
    ],
    "reason": "secret provider failed"
  },
  {
    "ownerKind": "account",
    "ownerId": "[\"/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent/openclaw-agent.sqlite\",\"platform-openai:default\"]",
    "state": "unavailable",
    "degradationState": "stale",
    "paths": [
      "/home/node/.openclaw/agents/octogee-bravo-proj-timer-coach/agent.auth-profiles.platform-openai:default.key"
    ],
    "reason": "secret provider failed"
  }
];
      server.setHandler("status", (params) => {
        captured = params;
        return { ok: true, payload: { degradedSecretOwners: owners, sensitive: "must-not-return" } };
      });
      expect(await client.degradedSecretsStatus!()).toEqual(owners);
      expect(captured).toEqual({ includeChannelSummary: false });
    });

    it.each([{}, { degradedSecretOwners: "unknown" }, { degradedSecretOwners: [{ ownerKind: "account", ownerId: "x", state: "unavailable", paths: "x", reason: "secret provider failed" }] }])("refuses incomplete owner diagnostics %j", async (payload) => {
      server.setHandler("status", () => ({ ok: true, payload }));
      await expect(client.degradedSecretsStatus!()).rejects.toMatchObject({ code: "invalid-response" });
    });

    it("throws OpenclawWireError('invalid-response') if the gateway returns a non-object payload", async () => {
      server.setHandler("secrets.reload", () => ({ ok: true, payload: "boom" }));
      await expect(client.secretsReload()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("throws when warningCount is present but not a number (regression: silent NaN)", async () => {
      server.setHandler("secrets.reload", () => ({
        ok: true,
        payload: { warningCount: "lots" },
      }));
      await expect(client.secretsReload()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });

    it("throws when ok is present but not a boolean", async () => {
      server.setHandler("secrets.reload", () => ({
        ok: true,
        payload: { ok: "yes" },
      }));
      await expect(client.secretsReload()).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });
  });

  describe("isGatewayUp", () => {
    it("returns true when the handshake succeeds", async () => {
      expect(await client.isGatewayUp(500)).toBe(true);
    });

    it("does NOT call channels.status (or any other RPC) — handshake completion is the liveness signal", async () => {

expect(await client.isGatewayUp(500)).toBe(true);
      expect(server.callCount("channels.status")).toBe(0);
    });

    it("returns false when the WS port is not reachable", async () => {
      await server.close();
      const offline = createGatewayRpc({
        url: "ws://127.0.0.1:1",
        token: "test-token",
        connectTimeoutMs: 250,
        callTimeoutMs: 250,
        identity: makeTestIdentity(),
      });
      try {
        expect(await offline.isGatewayUp(250)).toBe(false);
      } finally {
        await offline.close();
      }
    });

    it("returns false on connect-time auth failure", async () => {
      server.setRejectAllAsAuth(true);
      expect(await client.isGatewayUp(500)).toBe(false);
    });
  });

  describe("auth + transport errors", () => {
    it("throws OpenclawWireError('auth-failed') when the server rejects the connect frame", async () => {
      server.setRejectAllAsAuth(true);
      await expect(client.configPatch({}, "h")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "auth-failed",
      });
    });

    it("throws OpenclawWireError('timeout') when the connect never completes", async () => {
      server.setConnectHandler(() => ({ ok: true, payload: {} })); 

await server.close();
      const offline = createGatewayRpc({
        url: "ws://127.0.0.1:1",
        token: "t",
        connectTimeoutMs: 100,
        callTimeoutMs: 100,
        identity: makeTestIdentity(),
      });
      try {
        await expect(offline.configPatch({}, "h")).rejects.toMatchObject({
          name: "OpenclawWireError",
          code: "connect-failed",
        });
      } finally {
        await offline.close();
      }
    });

    it("throws OpenclawWireError('invalid-response') when the server replies with non-JSON", async () => {

server.setHandler("config.patch", () => ({ ok: true, payload: null }));
      await expect(client.configPatch({}, "h")).rejects.toMatchObject({
        name: "OpenclawWireError",
        code: "invalid-response",
      });
    });
  });

  describe("OpenclawWireError", () => {
    it("exposes code + message and is instanceof Error", () => {
      const e = new OpenclawWireError("hash-mismatch", "stale hash");
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe("hash-mismatch");
      expect(e.message).toBe("stale hash");
      expect(e.name).toBe("OpenclawWireError");
    });
  });

  describe("connect frame", () => {
    function verifyCapturedDeviceSignature(captured: any, authToken: string): boolean {
      const payload = [
        "v3",
        captured.device.id,
        captured.client.id,
        captured.client.mode,
        captured.role,
        captured.scopes.join(","),
        String(captured.device.signedAt),
        authToken,
        captured.device.nonce,
        (captured.client.platform ?? "").toLowerCase(),
        "", // deviceFamily left unset
      ].join("|");
      const sigBuf = Buffer.from(
        captured.device.signature.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - (captured.device.signature.length % 4)) % 4),
        "base64",
      );
      const pubRaw = Buffer.from(
        captured.device.publicKey.replaceAll("-", "+").replaceAll("_", "/") +
          "=".repeat((4 - (captured.device.publicKey.length % 4)) % 4),
        "base64",
      );
      const pubKey = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw]),
        type: "spki",
        format: "der",
      });
      return crypto.verify(null, Buffer.from(payload, "utf8"), pubKey, sigBuf);
    }

    it("requests operator.admin scope, signs the challenge nonce with the device identity, and identifies itself in `client.displayName`", async () => {
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
          },
        };
      });
      server.setHandler("channels.status", () => ({ ok: true, payload: { channels: [] } }));

      await client.isGatewayUp(500);

      expect(captured).toBeTruthy();
      expect(captured.scopes).toContain("operator.admin");
      expect(captured.role).toBe("operator");
      expect(captured.client.id).toBe("gateway-client");
      
      expect(captured.client.displayName?.toLowerCase()).toContain("octogee");

expect(captured.device).toBeTruthy();
      expect(typeof captured.device.id).toBe("string");
      expect(typeof captured.device.publicKey).toBe("string");
      expect(typeof captured.device.signature).toBe("string");
      expect(typeof captured.device.signedAt).toBe("number");
      expect(typeof captured.device.nonce).toBe("string");

      expect(verifyCapturedDeviceSignature(captured, captured.auth?.token ?? "")).toBe(true);
    });

    it("uses auth.deviceToken and signs with the device token when provided", async () => {
      let captured: any = null;
      server.setConnectHandler((params) => {
        captured = params;
        return {
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 4,
            server: { version: "test", connId: "c1" },
            features: { methods: [], events: [] },
            snapshot: {},
            policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
          },
        };
      });

      const rpc = createGatewayRpc({
        url: server.url,
        deviceToken: "device-token-abc123",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
      });
      try {
        await rpc.isGatewayUp(500);
      } finally {
        await rpc.close();
      }

      expect(captured?.auth).toEqual({ deviceToken: "device-token-abc123" });
      expect(captured?.auth?.token).toBeUndefined();
      expect(verifyCapturedDeviceSignature(captured, "device-token-abc123")).toBe(true);
    });
  });

  describe("onConnectTrace", () => {
    it("fires with success=true, stage=done, and all three phase timings on a clean connect", async () => {
      server.setHandler("channels.status", () => ({ ok: true, payload: {} }));

      const traces: ConnectTrace[] = [];
      const tracedClient = createGatewayRpc({
        url: server.url,
        token: "test",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
        onConnectTrace: (t) => traces.push(t),
      });
      try {
        await tracedClient.isGatewayUp(500);
      } finally {
        await tracedClient.close();
      }

      expect(traces).toHaveLength(1);
      const t = traces[0];
      expect(t.success).toBe(true);
      expect(t.stage).toBe("done");
      expect(t.url).toBe(server.url);
      expect(typeof t.wsOpenMs).toBe("number");
      expect(typeof t.challengeMs).toBe("number");
      expect(typeof t.connectMs).toBe("number");
      expect(t.totalMs).toBeGreaterThanOrEqual(
        (t.wsOpenMs ?? 0) + (t.challengeMs ?? 0) + (t.connectMs ?? 0) - 5, // ±5ms slack
      );
      expect(t.errorCode).toBeUndefined();
    });

    it("fires with stage=ws-open on a connect-failed timeout (nothing listening)", async () => {
      const traces: ConnectTrace[] = [];
      const offline = createGatewayRpc({
        url: "ws://127.0.0.1:1",
        token: "t",
        connectTimeoutMs: 80,
        callTimeoutMs: 80,
        identity: makeTestIdentity(),
        onConnectTrace: (t) => traces.push(t),
      });
      try {
        await offline.isGatewayUp(80);
      } finally {
        await offline.close();
      }

expect(traces.length).toBeGreaterThanOrEqual(1);
      const fail = traces.find((t) => !t.success);
      expect(fail).toBeTruthy();
      expect(fail?.stage).toBe("ws-open");
      expect(fail?.errorCode).toBe("connect-failed");
      
      expect(fail?.wsOpenMs).toBeUndefined();
      expect(fail?.challengeMs).toBeUndefined();
      expect(fail?.connectMs).toBeUndefined();
    });

    it("fires with stage=connect on an auth-failed connect frame (connect frame rejected)", async () => {
      server.setRejectAllAsAuth(true);
      const traces: ConnectTrace[] = [];
      const rpc = createGatewayRpc({
        url: server.url,
        token: "t",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
        onConnectTrace: (t) => traces.push(t),
      });
      try {
        await expect(rpc.configGet()).rejects.toThrow();
      } finally {
        await rpc.close();
      }

      const fail = traces.find((t) => !t.success);
      expect(fail).toBeTruthy();
      expect(fail?.stage).toBe("connect");
      expect(fail?.errorCode).toBe("auth-failed");
      
      expect(typeof fail?.wsOpenMs).toBe("number");
      expect(typeof fail?.challengeMs).toBe("number");
      
      expect(fail?.connectMs).toBeUndefined();
    });

    it("is optional — omitting onConnectTrace still works (production default uses config.log)", async () => {
      server.setHandler("channels.status", () => ({ ok: true, payload: {} }));
      
      const rpc = createGatewayRpc({
        url: server.url,
        token: "t",
        connectTimeoutMs: 500,
        callTimeoutMs: 500,
        identity: makeTestIdentity(),
      });
      try {
        expect(await rpc.isGatewayUp(500)).toBe(true);
      } finally {
        await rpc.close();
      }
    });
  });
});

describe("token resolution", () => {
  let tmpDir: string;
  let configPath: string;
  let origEnv: string | undefined;
  let origConfigPath: string | undefined;

  beforeEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rpc-token-"));
    configPath = path.join(tmpDir, "openclaw.json");
    origEnv = process.env.OPENCLAW_GATEWAY_TOKEN;
    origConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_CONFIG_PATH;
  });

  afterEach(() => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (origEnv === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = origEnv;
    if (origConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = origConfigPath;
  });

  it("does not read OPENCLAW_GATEWAY_TOKEN or openclaw.json by default", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { auth: { mode: "token", token: "from-file-abc123" } },
      }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "from-env-abc123";

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth).toBeUndefined();
  });

  it("reads gateway.auth.token from openclaw.json only when legacy fallback is explicit", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { auth: { mode: "token", token: "from-file-abc123" } },
      }),
    );

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth?.token).toBe("from-file-abc123");
  });

  it("uses OPENCLAW_CONFIG_PATH when legacy fallback has no explicit path", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "from-active-config" } } }),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });

    const rpc = createGatewayRpc({
      url: srv.url,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth?.token).toBe("from-active-config");
  });

  it("legacy fallback prefers the OPENCLAW_GATEWAY_TOKEN env var over openclaw.json", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "from-file" } } }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "from-env";

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

    expect(captured?.auth?.token).toBe("from-env");
  });

  it("sends no auth block when neither env nor file has a token (server rejects, caller falls back)", async () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { mode: "none" } } }));

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      await rpc.close();
      await srv.close();
    }

expect(captured?.auth).toBeUndefined();
  });

  it("excludes service probes from Online with backend mode while preserving trusted-proxy authentication", async () => {
    vi.stubEnv("API_PUBLIC_URL", "https://api-test.octogee.com/");
    const network = vi.mocked(os.networkInterfaces).mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: "127.0.0.1/8" }],
      eth0: [{ address: "10.8.0.4", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:01", cidr: "10.8.0.4/24" }],
    });
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { mode: "trusted-proxy", token: "must-not-be-read" } } }),
    );
    process.env.OPENCLAW_GATEWAY_TOKEN = "must-not-be-sent";
    process.env.OPENCLAW_CONTROL_IDENTITY = "per-user";

    const srv = await startMockGateway();
    let captured: any = null;
    srv.setConnectHandler((params) => {
      captured = params;
      return {
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "c1" },
          features: { methods: [], events: [] },
          snapshot: {},
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        },
      };
    });
    srv.setHandler("channels.status", () => ({ ok: true, payload: {} }));

    const rpc = createGatewayRpc({
      url: srv.url,
      openclawConfigPath: configPath,
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 500,
      callTimeoutMs: 500,
      identity: makeTestIdentity(),
    });
    try {
      await rpc.isGatewayUp(500);
    } finally {
      delete process.env.OPENCLAW_CONTROL_IDENTITY;
      network.mockRestore();
      await rpc.close();
      await srv.close();
    }

    expect(srv.lastUpgradeHeaders()).toMatchObject({
      "x-octogee-user": "svc:octogee-provisioner",
      "x-octogee-proxy": "1",
      "x-forwarded-for": "10.8.0.4",
      origin: "https://api-test.octogee.com",
    });
    expect(captured?.client).toMatchObject({ id: "openclaw-control-ui", mode: "backend" });
    expect(captured?.auth).toBeUndefined();
    expect(captured?.device).toBeUndefined();
    expect(captured?.scopes).toBeUndefined();
  });

  it("refuses per-user service RPC when no non-loopback client address is available", () => {
    const network = vi.mocked(os.networkInterfaces).mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00", cidr: "127.0.0.1/8" }],
    });
    process.env.OPENCLAW_CONTROL_IDENTITY = "per-user";
    try {
      expect(() => createGatewayRpc({ allowLegacyGatewayTokenFallback: true }))
        .toThrow("per-user service RPC requires a non-loopback IPv4 address");
    } finally {
      delete process.env.OPENCLAW_CONTROL_IDENTITY;
      network.mockRestore();
    }
  });

  it.each([undefined, "", "not-a-url", "https://api.test/path", "https://user:pass@api.test", "https://api.test/?query=1", "https://api.test/#fragment", "file:///tmp/api"])("refuses per-user service RPC with invalid API_PUBLIC_URL %s", (origin) => {
    vi.stubEnv("OPENCLAW_CONTROL_IDENTITY", "per-user");
    vi.stubEnv("API_PUBLIC_URL", origin);
    expect(() => createGatewayRpc({ allowLegacyGatewayTokenFallback: true }))
      .toThrow("per-user proxy authentication requires API_PUBLIC_URL to be an HTTP(S) origin");
  });

  it("silently tolerates a missing/malformed openclaw.json when legacy fallback is enabled", async () => {
    const rpc = createGatewayRpc({
      url: "ws://127.0.0.1:1",
      openclawConfigPath: "/does/not/exist.json",
      allowLegacyGatewayTokenFallback: true,
      connectTimeoutMs: 100,
      callTimeoutMs: 100,
      identity: makeTestIdentity(),
    });
    try {
      expect(await rpc.isGatewayUp(100)).toBe(false);
    } finally {
      await rpc.close();
    }
  });
});

describe("crash safety on connect timeout", () => {
  let tcpServer: Server;
  let tcpPort: number;
  let originalHandlers: Array<(err: Error) => void>;

  beforeEach(async () => {
    tcpServer = createServer(() => {
      // Accept the connection but NEVER speak. No WS upgrade response,
      // no close. The client's connect-timer is its only exit.
    });
    await new Promise<void>((resolve) => {
      tcpServer.listen(0, "127.0.0.1", () => resolve());
    });
    tcpPort = (tcpServer.address() as AddressInfo).port;

originalHandlers = process.listeners("uncaughtException") as any;
  });

  afterEach(() => {
    tcpServer.close();
    
    const now = process.listeners("uncaughtException") as any;
    for (const h of now) {
      if (!originalHandlers.includes(h)) process.off("uncaughtException", h);
    }
  });

  it("rejects with connect-failed and does NOT emit an unhandled 'error' event when terminate() fires", async () => {
    const crashes: unknown[] = [];
    const crashCatcher = (err: unknown) => crashes.push(err);
    process.on("uncaughtException", crashCatcher);

    const client = createGatewayRpc({
      url: `ws://127.0.0.1:${tcpPort}`,
      token: "t",
      connectTimeoutMs: 80,
      callTimeoutMs: 80,
      identity: makeTestIdentity(),
    });

    await expect(client.configGet()).rejects.toMatchObject({
      name: "OpenclawWireError",
      code: "connect-failed",
    });

await new Promise((r) => setTimeout(r, 50));
    process.off("uncaughtException", crashCatcher);

    expect(crashes).toEqual([]);
    await client.close();
  });
});

describe("initial agent automation", () => {
  it("uses the upstream proactive job contract through the existing scheduler", async () => {
    const cronAdd = vi.fn(async (_job: CronAddSpec) => ({ id: "monitor" }));
    await provisionDefaultAgentAutomation({ cronAdd }, { slug: "test", coachChannelId: "c".repeat(26) });
    expect(cronAdd).toHaveBeenCalledWith({
      declarationKey: "octogee:coach-monitor:octogee-test-coach",
      name: "Proactive check (octogee-test-coach)",
      agentId: "octogee-test-coach",
      enabled: true,
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "session:agent:octogee-test-coach:main",
      sessionKey: "agent:octogee-test-coach:main",
      wakeMode: "now",
      idleOnly: true,
      payload: {
        kind: "agentTurn",
        message: "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.",
        skipIfScratchEmpty: true,
      },
      delivery: { mode: "announce", channel: "mattermost", accountId: "test-coach", to: `channel:${"c".repeat(26)}` },
    });
  });

  it("binds each agent job to its workspace's verified private agent channel", async () => {
    const cronAdd = vi.fn(async (_job: CronAddSpec) => ({ id: "monitor" }));
    await provisionDefaultAgentAutomation({ cronAdd }, { slug: "alice", coachChannelId: "a".repeat(26) });
    await provisionDefaultAgentAutomation({ cronAdd }, { slug: "bob", coachChannelId: "b".repeat(26) });
    expect(cronAdd.mock.calls.map(([job]) => job.delivery)).toEqual([
      { mode: "announce", channel: "mattermost", accountId: "alice-coach", to: `channel:${"a".repeat(26)}` },
      { mode: "announce", channel: "mattermost", accountId: "bob-coach", to: `channel:${"b".repeat(26)}` },
    ]);
  });

  it("refuses initial monitoring without a canonical user destination", () => {
    const cronAdd = vi.fn();
    expect(() => provisionDefaultAgentAutomation({ cronAdd }, { slug: "alice", coachChannelId: null }))
      .toThrow("requires its workspace's private agent channel ID");
    expect(cronAdd).not.toHaveBeenCalled();
  });
});
