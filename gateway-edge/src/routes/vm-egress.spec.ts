import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import type { GatewayEgressMode, GatewayVmEgressState } from "@octogee/shared/types/glm";
vi.mock("@octogee/core/http/auth", () => ({ requireAuthenticatedUid: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = "builder"; next(); } }));
import { createVmEgressRouter } from "./vm-egress.js";
import { createVmEgressService, type VmEgressService, type EgressStore } from "../egress/service.js";
import { createEgressTunnelHost } from "../egress/tunnel-host.js";
import type { NativeAdminAccessOutcome } from "../lib/native-admin-access.js";

const resolveAccess = vi.fn<() => Promise<NativeAdminAccessOutcome>>();
const env = { GATEWAY_ID: "b-user" } as NodeJS.ProcessEnv;
const owner: NativeAdminAccessOutcome = { kind: "allowed", gatewayId: "b-user", workspaceSlug: "alice", canControl: true };

function memoryStore(): EgressStore & { state: GatewayVmEgressState | null; fail: boolean } {
  const store = {
    state: null as GatewayVmEgressState | null,
    fail: false,
    async read() { return store.state; },
    async write(mode: GatewayEgressMode) {
      if (store.fail) throw new Error("broker down");
      store.state = { mode, updatedAt: 42 };
      return store.state;
    },
  };
  return store;
}

const services: VmEgressService[] = [];
const servers: Server[] = [];
const sockets: WebSocket[] = [];
beforeEach(() => { vi.clearAllMocks(); resolveAccess.mockResolvedValue(owner); });
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(services.splice(0).map((service) => service.stop()));
});

async function harness(options: { listening?: boolean; pendingMode?: boolean } = {}) {
  const store = memoryStore();
  let releaseRead: () => void = () => {};
  if (options.pendingMode) store.read = () => new Promise((resolve) => { releaseRead = () => resolve(store.state); });
  const service = createVmEgressService({ store, directDial: () => Promise.reject(new Error("direct dial unused")), tunnel: createEgressTunnelHost(), listen: { host: "127.0.0.1", port: 0 } });
  services.push(service);
  if (options.pendingMode) void service.boot({ schedule: () => {} });
  else if (options.listening !== false) await service.start();
  const egress = createVmEgressRouter({ service, env, resolveAccess, authorizationIntervalMs: 20, log: () => {} });
  const app = express();
  app.use(express.json());
  app.use("/api/g/:gatewayId/computer", egress.router);
  return { store, service, egress, app, releaseRead: () => releaseRead() };
}

describe("owner-only VM egress routes", () => {
  it("reports status, changes mode through the store, and mints tickets for the controlling owner only", async () => {
    const { store, app } = await harness();
    const status = await request(app).get("/api/g/b-user/computer/egress");
    expect(status.status).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.body).toMatchObject({ mode: "cloud", shell: "disconnected", listener: "listening" });

    const changed = await request(app).post("/api/g/b-user/computer/egress/mode").send({ mode: "desktop" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ mode: "desktop", updatedAt: 42 });
    expect(store.state).toEqual({ mode: "desktop", updatedAt: 42 });

    const ticket = await request(app).post("/api/g/b-user/computer/egress/ticket").send({});
    expect(ticket.status).toBe(200);
    expect(ticket.body.ticket).toMatch(/^[0-9a-f-]{36}$/u);
    expect(resolveAccess).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "b-user", env }));
  });

  it("refuses viewers, members without control, unknown gateways, and a VM whose listener is off", async () => {
    const { app, store } = await harness();
    for (const [access, expected] of [
      [{ kind: "forbidden" }, 403],
      [{ kind: "unauthenticated" }, 401],
      [{ kind: "not_found" }, 404],
      [{ ...owner, canControl: false }, 403],
    ] as Array<[NativeAdminAccessOutcome, number]>) {
      resolveAccess.mockResolvedValueOnce(access);
      expect((await request(app).post("/api/g/b-user/computer/egress/mode").send({ mode: "desktop" })).status, access.kind).toBe(expected);
    }
    expect(store.state).toBeNull();
    resolveAccess.mockClear();
    expect((await request(app).get("/api/g/b-other/computer/egress")).status).toBe(404);
    expect(resolveAccess).not.toHaveBeenCalled();

    const off = await harness({ listening: false });
    expect((await request(off.app).get("/api/g/b-user/computer/egress")).status).toBe(404);
    expect((await request(off.app).post("/api/g/b-user/computer/egress/ticket").send({})).status).toBe(404);
  });

  it("reports a VM whose listener is still closed waiting for its mode, and lets an explicit mode change settle it", async () => {
    const pending = await harness({ pendingMode: true });
    pending.store.state = { mode: "desktop", updatedAt: 7 };
    const status = await request(pending.app).get("/api/g/b-user/computer/egress");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ listener: "closed-pending-mode", mode: "cloud" });
    expect((await request(pending.app).post("/api/g/b-user/computer/egress/ticket").send({})).status).toBe(200);
    const changing = request(pending.app).post("/api/g/b-user/computer/egress/mode").send({ mode: "cloud" }).then((res) => res);
    await vi.waitFor(() => expect(pending.store.state?.mode).toBe("cloud"));
    pending.releaseRead();
    const changed = await changing;
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ mode: "cloud", listener: "listening" });
    expect(pending.service.status()).toMatchObject({ mode: "cloud", listener: "listening" });
  });

  it("waits for a slow store write and reports the mode it actually applied, never a failure that later applies", async () => {
    const { app, store, service } = await harness();
    let finishWrite: () => void = () => {};
    const write = store.write.bind(store);
    store.write = (mode) => new Promise((resolve, reject) => { finishWrite = () => { write(mode).then(resolve, reject); }; });
    const pending = request(app).post("/api/g/b-user/computer/egress/mode").send({ mode: "desktop" }).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(service.status().mode).toBe("cloud");
    finishWrite();
    const changed = await pending;
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ mode: "desktop", updatedAt: 42 });
    expect(service.status().mode).toBe("desktop");
  });

  it("rejects malformed mode changes and reports a failed persistence without switching", async () => {
    const { app, store, service } = await harness();
    for (const body of [{}, { mode: "tor" }, { mode: "desktop", extra: 1 }, { mode: 1 }]) {
      expect((await request(app).post("/api/g/b-user/computer/egress/mode").send(body)).status).toBe(400);
    }
    store.fail = true;
    const failed = await request(app).post("/api/g/b-user/computer/egress/mode").send({ mode: "desktop" });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "egress_unavailable" });
    expect(service.status().mode).toBe("cloud");
  });

  it("attaches the desktop over a ticketed, origin-checked upgrade and drops it when authorization ends", async () => {
    const { app, egress, service } = await harness();
    await service.setMode("desktop");
    const upgrades = new WsUpgradeRouter();
    egress.attachWs(upgrades, (origin) => origin === "https://app.octogee.com");
    const server = http.createServer(app);
    servers.push(server);
    server.on("upgrade", (req, socket, head) => { if (!upgrades.dispatch(req, socket, head)) socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const mint = async () => (await request(app).post("/api/g/b-user/computer/egress/ticket").send({})).body.ticket as string;

    const foreignOrigin = new WebSocket(`ws://127.0.0.1:${port}/computer/egress/${await mint()}`, { headers: { origin: "https://evil.example" } });
    sockets.push(foreignOrigin);
    const [foreignError] = (await once(foreignOrigin, "error")) as [Error];
    expect(foreignError.message).toContain("403");

    const bogus = new WebSocket(`ws://127.0.0.1:${port}/computer/egress/00000000-0000-4000-8000-000000000000`, { headers: { origin: "https://app.octogee.com" } });
    sockets.push(bogus);
    const [bogusError] = (await once(bogus, "error")) as [Error];
    expect(bogusError.message).toContain("401");

    const ticket = await mint();
    const shell = new WebSocket(`ws://127.0.0.1:${port}/computer/egress/${ticket}`, { headers: { origin: "https://app.octogee.com" } });
    sockets.push(shell);
    await once(shell, "open");
    await vi.waitFor(() => expect(service.status().shell).toBe("connected"));

    const replay = new WebSocket(`ws://127.0.0.1:${port}/computer/egress/${ticket}`, { headers: { origin: "https://app.octogee.com" } });
    sockets.push(replay);
    const [replayError] = (await once(replay, "error")) as [Error];
    expect(replayError.message).toContain("401");
    expect(service.status().shell).toBe("connected");

    const replacement = new WebSocket(`ws://127.0.0.1:${port}/computer/egress/${await mint()}`, { headers: { origin: "https://app.octogee.com" } });
    sockets.push(replacement);
    const replacementOpened = once(replacement, "open");
    const [code] = (await once(shell, "close")) as [number];
    expect(code).toBe(4002);
    await replacementOpened;
    await vi.waitFor(() => expect(service.status().shell).toBe("connected"));

    const revoked = once(replacement, "close");
    resolveAccess.mockResolvedValue({ kind: "forbidden" });
    const [revokedCode] = (await revoked) as [number];
    expect(revokedCode).toBe(1008);
    await vi.waitFor(() => expect(service.status().shell).toBe("disconnected"));
  });
});
