import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
vi.mock("@octogee/core/http/auth", () => ({ requireAuthenticatedUid: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = "builder"; next(); } }));
import { createVmPasskeysRouter } from "./vm-passkeys.js";
import { createPasskeyLinkHost } from "../webauthn/link-host.js";
import { decodePasskeyMessage, encodePasskeyMessage, PASSKEY_CLOSE_REPLACED } from "../webauthn/protocol.js";
import type { NativeAdminAccessOutcome } from "../lib/native-admin-access.js";

const resolveAccess = vi.fn<() => Promise<NativeAdminAccessOutcome>>();
const env = { GATEWAY_ID: "b-user" } as NodeJS.ProcessEnv;
const owner: NativeAdminAccessOutcome = { kind: "allowed", gatewayId: "b-user", workspaceSlug: "alice", canControl: true };
const servers: Server[] = [];
const sockets: WebSocket[] = [];
beforeEach(() => { vi.clearAllMocks(); resolveAccess.mockResolvedValue(owner); });
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function harness(options: { available?: boolean } = {}) {
  const host = createPasskeyLinkHost();
  const passkeys = createVmPasskeysRouter({ host, env, available: () => options.available ?? true, resolveAccess, authorizationIntervalMs: 20, log: () => {} });
  const app = express();
  app.use(express.json());
  app.use("/api/g/:gatewayId/computer", passkeys.router);
  return { host, passkeys, app };
}

describe("owner-only VM passkey link", () => {
  it("mints tickets for the controlling owner whatever the egress mode, and refuses everyone else", async () => {
    const { app } = harness();
    const ticket = await request(app).post("/api/g/b-user/computer/passkeys/ticket").send({});
    expect(ticket.status).toBe(200);
    expect(ticket.headers["cache-control"]).toBe("no-store");
    expect(ticket.body.ticket).toMatch(/^[0-9a-f-]{36}$/u);
    resolveAccess.mockResolvedValue({ ...owner, canControl: false });
    expect((await request(app).post("/api/g/b-user/computer/passkeys/ticket").send({})).status).toBe(403);
    expect((await request(app).post("/api/g/b-other/computer/passkeys/ticket").send({})).status).toBe(404);
    expect((await request(harness({ available: false }).app).post("/api/g/b-user/computer/passkeys/ticket").send({})).status).toBe(404);
  });

  it("bounds passkey ticket broker calls per authenticated account", async () => {
    const { app } = harness();
    const client = request(app);
    const path = "/api/g/b-user/computer/passkeys/ticket";
    for (let attempt = 0; attempt < 60; attempt++) await client.post(path).expect(200);
    const limited = await client.post(path).expect(429);
    expect(limited.body).toEqual({ error: "Too many requests, please try again later." });
    expect(resolveAccess).toHaveBeenCalledTimes(60);
  });

  it("links the desktop over a ticketed, origin-checked upgrade, relays passkey requests, and drops it when authorization ends", async () => {
    const { app, passkeys, host } = harness();
    const upgrades = new WsUpgradeRouter();
    passkeys.attachWs(upgrades, (origin) => origin === "https://app.octogee.com");
    const server = http.createServer(app);
    servers.push(server);
    server.on("upgrade", (req, socket, head) => { if (!upgrades.dispatch(req, socket, head)) socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const mint = async () => (await request(app).post("/api/g/b-user/computer/passkeys/ticket").send({})).body.ticket as string;
    const open = (ticket: string, origin = "https://app.octogee.com") => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/computer/passkeys/${ticket}`, { headers: { origin } });
      sockets.push(socket);
      return socket;
    };

    const [foreignError] = (await once(open(await mint(), "https://evil.example"), "error")) as [Error];
    expect(foreignError.message).toContain("403");
    const [bogusError] = (await once(open("00000000-0000-4000-8000-000000000000"), "error")) as [Error];
    expect(bogusError.message).toContain("401");

    const desktop = open(await mint());
    await once(desktop, "open");
    await vi.waitFor(() => expect(host.connected()).toBe(true));
    desktop.on("message", (data) => {
      const message = decodePasskeyMessage(String(data));
      if (message.type === "request") desktop.send(encodePasskeyMessage({ type: "response", id: message.id, response: { ok: true, credential: { id: "from-desktop" } } }));
    });
    await expect(host.request({ origin: "https://login.example", rpId: "login.example", kind: "get", options: { challenge: "AQID" } })).resolves.toEqual({ ok: true, credential: { id: "from-desktop" } });

    const replacement = open(await mint());
    const replacementOpened = once(replacement, "open");
    const [code] = (await once(desktop, "close")) as [number];
    expect(code).toBe(PASSKEY_CLOSE_REPLACED);
    await replacementOpened;

    const revoked = once(replacement, "close");
    resolveAccess.mockResolvedValue({ kind: "forbidden" });
    const [revokedCode] = (await revoked) as [number];
    expect(revokedCode).toBe(1008);
    await vi.waitFor(() => expect(host.connected()).toBe(false));
  });
});
