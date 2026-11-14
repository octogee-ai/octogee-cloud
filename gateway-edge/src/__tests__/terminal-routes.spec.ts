import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { WebSocket, WebSocketServer } from "ws";
import { WsUpgradeRouter } from "@octogee/core/ws/upgrade-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uidForBearer } = vi.hoisted(() => ({ uidForBearer: vi.fn<(token: string) => Promise<string>>() }));

vi.mock("../lib/db", () => ({
  db: {},
}));
vi.mock("../middleware/logging", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  attachTerminalWsRoute,
  createTerminalRouter,
  decideTerminalRequest,
  terminalAvailable,
  terminalServerFrameAllowed,
  terminalTicketFromPath,
  type TerminalRouterDeps,
  type TerminalSession,
} from "../routes/terminal.js";
import { applyGatewayPrefixStripInPlace } from "../chat-proxy/gateway-prefix.js";
import type { NativeAdminAccessOutcome } from "../lib/native-admin-access.js";
import { WS_TICKET_TTL_MS, createWsTicketStore } from "../lib/ws-ticket-store.js";
import { installBearerUids } from "./helpers/user-bearer.js";

installBearerUids(uidForBearer);

const OWNER = "uid-owner";
const GATEWAY = "b-x";
const channelId = "a".repeat(26);
const threadRootPostId = "r".repeat(26);
const selected = { channelId };

const ACCESS: Record<string, NativeAdminAccessOutcome> = {
  owner: { kind: "allowed", gatewayId: GATEWAY, workspaceSlug: "alice", canControl: true },
  member: { kind: "forbidden" },
};

const resolveAccess = vi.fn<TerminalRouterDeps["resolveAccess"]>();

function appFor(overrides: Partial<TerminalRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/g/:gatewayId/terminal",
    createTerminalRouter({
      localGatewayId: () => GATEWAY,
      available: true,
      resolveAccess,
      resolveChannel: async () => ({ agentId: 'coach', sessionKey: `agent:coach:mattermost:group:${channelId}` }),
      tickets: createWsTicketStore<TerminalSession>(),
      ...overrides,
    }),
  );
  return app;
}

function as(principal: keyof typeof ACCESS) {
  return { Authorization: `Bearer ${principal}` };
}

beforeEach(() => {
  uidForBearer.mockReset();
  uidForBearer.mockImplementation(async (token: string) => {
    if (token in ACCESS) return token === "owner" ? OWNER : `uid-${token}`;
    throw new Error("bad token");
  });
  resolveAccess.mockReset();
  resolveAccess.mockImplementation(async ({ authorization }) => {
    const principal = authorization?.replace(/^Bearer /u, "") ?? "";
    return ACCESS[principal] ?? { kind: "unauthenticated" };
  });
});

describe("terminal locality route — ticket boundary", () => {
  it("rejects requests without a bearer token before asking the broker", async () => {
    const res = await request(appFor()).post(`/api/g/${GATEWAY}/terminal/ticket`);
    expect(res.status).toBe(401);
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("limits ticket requests per verified user before resolving native access", async () => {
    const app = appFor();
    const path = `/api/g/${GATEWAY}/terminal/ticket`;
    for (let index = 0; index < 30; index++) {
      await request(app).post(path).set(as("owner")).send(selected).expect(200);
    }
    await request(app).post(path).set(as("owner")).send(selected).expect(429);
    expect(resolveAccess).toHaveBeenCalledTimes(30);
    await request(app).post(path).set(as("member")).send(selected).expect(403);
  });

  it("answers 403 forbidden for a workspace member without native admin scope", async () => {
    const res = await request(appFor()).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("member"));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("answers 404 terminal_unavailable when the path names another gateway than this pod", async () => {
    const res = await request(appFor()).post("/api/g/b-other/terminal/ticket").set(as("owner")).send(selected);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "terminal_unavailable" });
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("answers 404 terminal_unavailable on a gateway without a per-user user identity", async () => {
    const res = await request(appFor({ available: false })).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send(selected);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "terminal_unavailable" });
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("answers 404 terminal_unavailable when the broker knows no owned gateway", async () => {
    resolveAccess.mockResolvedValue({ kind: "not_found" });
    const res = await request(appFor()).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send(selected);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "terminal_unavailable" });
  });

  it("answers 503 access_unavailable when the broker cannot answer", async () => {
    resolveAccess.mockRejectedValue(new Error("broker down"));
    const res = await request(appFor()).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send(selected);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "access_unavailable" });
  });

  it("opens a channel-bound terminal ticket without a selected thread", async () => {
    const tickets = createWsTicketStore<TerminalSession>();
    const issue = vi.spyOn(tickets, "issue");
    const result = await request(appFor({ tickets })).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send({ channelId });
    expect(result.status).toBe(200); expect(issue).toHaveBeenCalledOnce();
    expect(tickets.redeem(result.body.ticket)?.conversation).toEqual({ agentId: 'coach', sessionKey: `agent:coach:mattermost:group:${channelId}` });
  });
  it("refuses a client-supplied reply root on a workspace terminal ticket", async () => {
    const result = await request(appFor()).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send({ channelId, threadRootPostId });
    expect(result.status).toBe(400);
  });
  it("mints a one-time ticket bound to the caller and this gateway", async () => {
    const tickets = createWsTicketStore<TerminalSession>();
    const res = await request(appFor({ tickets })).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send(selected);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ expiresInMs: WS_TICKET_TTL_MS });
    expect(res.body.ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(tickets.redeem(res.body.ticket)).toMatchObject({
      uid: OWNER, gatewayId: GATEWAY, workspaceSlug: "alice", reauthorize: expect.any(Function),
    });
    expect(tickets.redeem(res.body.ticket)).toBeNull();
  });

  it("binds a channel ticket to the server conversation and rechecks that identity", async () => {
    const tickets = createWsTicketStore<TerminalSession>();
    const resolveChannel = vi.fn().mockResolvedValue({ agentId: "coach", sessionKey: "agent:coach:mattermost:group:channel" });
    const channelId = "a".repeat(26);
    const res = await request(appFor({ tickets, resolveChannel })).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send({ channelId });
    expect(res.status).toBe(200);
    expect(resolveChannel).toHaveBeenCalledWith({ uid: OWNER, gatewayId: GATEWAY, channelId });
    const session = tickets.redeem(res.body.ticket)!;
    expect(session.conversation).toEqual({ agentId: "coach", sessionKey: "agent:coach:mattermost:group:channel" });
    expect(await session.reauthorize()).toBe(true);
    resolveChannel.mockResolvedValue({ agentId: "coach", sessionKey: "foreign" });
    expect(await session.reauthorize()).toBe(false);
  });

  it("rejects a client-supplied terminal owner before issuing a ticket", async () => {
    const tickets = createWsTicketStore<TerminalSession>();
    const issue = vi.spyOn(tickets, "issue");
    const res = await request(appFor({ tickets })).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send({ sessionKey: "foreign" });
    expect(res.status).toBe(400); expect(issue).not.toHaveBeenCalled();
  });

  it.each([
    ["lost admin scope", ACCESS.member],
    ["expired identity token", { kind: "unauthenticated" }],
    ["removed gateway", { kind: "not_found" }],
    ["changed workspace", { ...ACCESS.owner, workspaceSlug: "other" }],
  ] as const)("revalidates a ticket against %s using the original bearer", async (_change, current) => {
    const tickets = createWsTicketStore<TerminalSession>();
    const res = await request(appFor({ tickets })).post(`/api/g/${GATEWAY}/terminal/ticket`).set(as("owner")).send(selected);
    const session = tickets.redeem(res.body.ticket)!;
    resolveAccess.mockResolvedValue(current);
    await expect(session.reauthorize()).resolves.toBe(false);
    expect(resolveAccess).toHaveBeenLastCalledWith({ gatewayId: GATEWAY, authorization: "Bearer owner" });
    resolveAccess.mockResolvedValue(ACCESS.owner);
    await expect(session.reauthorize()).resolves.toBe(true);
  });
});

describe("terminalAvailable", () => {
  it("is on only for a per-user isolated gateway", () => {
    expect(terminalAvailable({ OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_CLASS: "isolated" })).toBe(true);
    expect(terminalAvailable({ OPENCLAW_CONTROL_IDENTITY: "per-user", GATEWAY_CLASS: "shared" })).toBe(false);
    expect(terminalAvailable({ GATEWAY_CLASS: "isolated" })).toBe(false);
  });
});

describe("terminalTicketFromPath", () => {
  it("accepts only a UUID ticket segment under the terminal ws path", () => {
    const ticket = "123e4567-e89b-42d3-a456-426614174000";
    expect(terminalTicketFromPath(`/terminal/ws/${ticket}`)).toBe(ticket);
    expect(terminalTicketFromPath("/terminal/ws/")).toBeNull();
    expect(terminalTicketFromPath("/terminal/ws/not-a-uuid")).toBeNull();
    expect(terminalTicketFromPath(`/computer/vnc/${ticket}`)).toBeNull();
  });
});

const DEFAULT_AGENT = "octogee-alice-coach";
const decide = (raw: string, defaultAgentId: string | null = null) => decideTerminalRequest(raw, { defaultAgentId });

describe("decideTerminalRequest — the browser may only speak OpenClaw's terminal family", () => {
  const req = (method: string, params?: unknown, id = "r1") => JSON.stringify({ type: "req", id, method, params });

  it.each([
    ["terminal.open", { cols: 120, rows: 40 }],
    ["terminal.open", { cols: 1, rows: 1, agentId: "coach" }],
    ["terminal.attach", { sessionId: "s1" }],
    ["terminal.close", { sessionId: "s1" }],
    ["terminal.input", { sessionId: "s1", data: "ls\r" }],
    ["terminal.input", { sessionId: "s1", data: "" }],
    ["terminal.resize", { sessionId: "s1", cols: 80, rows: 24 }],
    ["terminal.list", {}],
    ["terminal.list", undefined],
  ])("forwards %s with %j", (method, params) => {
    const decision = decide(req(method, params));
    expect(decision).toMatchObject({ allowed: true });
    expect(JSON.parse((decision as { outbound: string }).outbound)).toEqual({ type: "req", id: "r1", method, params: params ?? {} });
  });

  it.each([
    ["terminal.upload", { sessionId: "s1", name: "a", contentBase64: "" }],
    ["config.get", {}],
    ["chat.send", { message: "hi" }],
    ["sessions.catalog.startTerminal", {}],
  ])("refuses %s as method-unavailable", (method, params) => {
    expect(decide(req(method, params))).toEqual({ allowed: false, id: "r1", reason: "method-unavailable" });
  });

  it.each([
    ["terminal.open", { cols: 0, rows: 40 }],
    ["terminal.open", { cols: 120, rows: 2001 }],
    ["terminal.open", { cols: 120, rows: 40, sessionKey: "agent:main" }],
    ["terminal.open", { cols: 120, rows: 40, catalog: { catalogId: "codex" } }],
    ["terminal.input", { sessionId: "s1", data: "x".repeat(64 * 1024 + 1) }],
    ["terminal.input", { sessionId: "", data: "x" }],
    ["terminal.resize", { sessionId: "s1", cols: 80 }],
    ["terminal.attach", { sessionId: "s1", extra: true }],
    ["terminal.list", { verbose: true }],
  ])("refuses %s with %j as params-invalid", (method, params) => {
    expect(decide(req(method, params))).toEqual({ allowed: false, id: "r1", reason: "params-invalid" });
  });

  it("binds a shell to the user's agent when the browser names no agent, and keeps an explicit choice", () => {
    const bound = decide(req("terminal.open", { cols: 80, rows: 24 }), DEFAULT_AGENT);
    expect(JSON.parse((bound as { outbound: string }).outbound).params).toEqual({ cols: 80, rows: 24, agentId: DEFAULT_AGENT });
    const explicit = decide(req("terminal.open", { cols: 80, rows: 24, agentId: "octogee-alice-p-rocket-coach" }), DEFAULT_AGENT);
    expect(JSON.parse((explicit as { outbound: string }).outbound).params.agentId).toBe("octogee-alice-p-rocket-coach");
    const attach = decide(req("terminal.attach", { sessionId: "s1" }), DEFAULT_AGENT);
    expect(JSON.parse((attach as { outbound: string }).outbound).params).toEqual({ sessionId: "s1" });
  });

  it("refuses frames that are not well-formed requests", () => {
    expect(decide("not json")).toEqual({ allowed: false, id: null, reason: "invalid-frame" });
    expect(decide(JSON.stringify({ type: "event", event: "terminal.data" }))).toEqual({ allowed: false, id: null, reason: "invalid-frame" });
    expect(decide(JSON.stringify({ type: "req", method: "terminal.list" }))).toEqual({ allowed: false, id: null, reason: "invalid-frame" });
    expect(decide(JSON.stringify({ type: "req", id: "r1", method: "terminal.list", params: [] }))).toEqual({ allowed: false, id: "r1", reason: "invalid-frame" });
    expect(decide(JSON.stringify({ type: "req", id: "r1", method: "__proto__" }))).toEqual({ allowed: false, id: "r1", reason: "method-unavailable" });
  });
});

describe("terminalServerFrameAllowed — only responses and terminal events reach the browser", () => {
  it("passes responses and terminal.data / terminal.exit events", () => {
    expect(terminalServerFrameAllowed(JSON.stringify({ type: "res", id: "r1", ok: true, payload: {} }))).toBe(true);
    expect(terminalServerFrameAllowed(JSON.stringify({ type: "event", event: "terminal.data", payload: { sessionId: "s1", seq: 1, data: "x" } }))).toBe(true);
    expect(terminalServerFrameAllowed(JSON.stringify({ type: "event", event: "terminal.exit", payload: { sessionId: "s1" } }))).toBe(true);
  });

  it("drops every other gateway broadcast", () => {
    expect(terminalServerFrameAllowed(JSON.stringify({ type: "event", event: "sessions.changed", payload: {} }))).toBe(false);
    expect(terminalServerFrameAllowed(JSON.stringify({ type: "event", event: "chat", payload: {} }))).toBe(false);
    expect(terminalServerFrameAllowed(JSON.stringify({ type: "res", ok: true }))).toBe(false);
    expect(terminalServerFrameAllowed("nope")).toBe(false);
  });
});

describe("terminal websocket relay", () => {
  let upstream: WebSocketServer;
  let upstreamUrl: string;
  let edge: http.Server;
  let edgeUrl: string;
  let tickets: ReturnType<typeof createWsTicketStore<TerminalSession>>;
  let scopes: Set<string>;
  const upstreamReceived: unknown[] = [];
  const logged: string[] = [];
  const reauthorize = vi.fn<() => Promise<boolean>>();
  const openUpstream = vi.fn(async (_session: TerminalSession) => {
    const ws = new WebSocket(upstreamUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return { ws, scopes };
  });

  beforeEach(async () => {
    upstreamReceived.length = 0;
    logged.length = 0;
    scopes = new Set(["operator.admin", "operator.read"]);
    reauthorize.mockReset().mockResolvedValue(true);
    openUpstream.mockClear();
    upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => upstream.once("listening", resolve));
    upstream.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { id: string; method: string; params: unknown };
        upstreamReceived.push(frame);
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { echo: frame.method } }));
        if (frame.method === "terminal.open") {
          socket.send(JSON.stringify({ type: "event", event: "sessions.changed", payload: { sessions: [] } }));
          socket.send(JSON.stringify({ type: "event", event: "terminal.data", payload: { sessionId: "s1", seq: 5, data: "hello" } }));
        }
      });
    });
    upstreamUrl = `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    tickets = createWsTicketStore<TerminalSession>();
    const router = new WsUpgradeRouter();
    attachTerminalWsRoute({
      router,
      tickets,
      defaultAgentId: () => DEFAULT_AGENT,
      openUpstream,
      isAllowedOrigin: (origin) => origin === "https://app.example",
      log: (message) => { logged.push(message); },
      authorizationIntervalMs: 20,
      authorizationTimeoutMs: 60,
    });
    edge = http.createServer((_req, res) => res.end());
    edge.on("upgrade", (req, socket, head) => {
      applyGatewayPrefixStripInPlace(req);
      if (!router.dispatch(req, socket, head)) {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      }
    });
    await new Promise<void>((resolve) => edge.listen(0, resolve));
    edgeUrl = `ws://127.0.0.1:${(edge.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const client of upstream.clients) client.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => edge.close(() => resolve()));
  });

  const session = (): TerminalSession => ({ uid: OWNER, gatewayId: GATEWAY, workspaceSlug: "alice", reauthorize });

  function connect(path: string, origin = "https://app.example") {
    return new WebSocket(`${edgeUrl}${path}`, { headers: { origin } });
  }

  function upgradeFailure(ws: WebSocket): Promise<number> {
    return new Promise((resolve, reject) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    });
  }

  async function openRelay(): Promise<{ ws: WebSocket; frames: unknown[]; closed: Promise<number> }> {
    const { ticket } = tickets.issue(session());
    const ws = connect(`/api/g/${GATEWAY}/terminal/ws/${ticket}`);
    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    await new Promise<void>((resolve) => ws.once("open", resolve));
    return { ws, frames, closed };
  }

  it("refuses an unknown ticket with 401 and never dials OpenClaw", async () => {
    await expect(upgradeFailure(connect(`/api/g/${GATEWAY}/terminal/ws/123e4567-e89b-42d3-a456-426614174000`))).resolves.toBe(401);
    expect(openUpstream).not.toHaveBeenCalled();
  });

  it("rejects an issued ticket after native admin access is revoked", async () => {
    const { ticket } = tickets.issue(session());
    reauthorize.mockResolvedValue(false);
    await expect(upgradeFailure(connect(`/api/g/${GATEWAY}/terminal/ws/${ticket}`))).resolves.toBe(401);
    expect(tickets.redeem(ticket)).toBeNull();
    expect(openUpstream).not.toHaveBeenCalled();
  });

  it("fails a ticket closed when the authorization broker is down", async () => {
    reauthorize.mockRejectedValue(new Error("sensitive broker detail"));
    const { ticket } = tickets.issue(session());
    await expect(upgradeFailure(connect(`/api/g/${GATEWAY}/terminal/ws/${ticket}`))).resolves.toBe(503);
    expect(logged).toEqual(["terminal ticket authorization denied"]);
  });

  it("refuses a disallowed origin with 403", async () => {
    const { ticket } = tickets.issue(session());
    await expect(upgradeFailure(connect(`/api/g/${GATEWAY}/terminal/ws/${ticket}`, "https://evil.example"))).resolves.toBe(403);
  });

  it("relays terminal requests as the native user and forwards only terminal events back", async () => {
    const { ws, frames } = await openRelay();
    ws.send(JSON.stringify({ type: "req", id: "open-1", method: "terminal.open", params: { cols: 100, rows: 30 } }));
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(openUpstream).toHaveBeenCalledWith(expect.objectContaining({ uid: OWNER, gatewayId: GATEWAY }));
    expect(upstreamReceived).toEqual([{ type: "req", id: "open-1", method: "terminal.open", params: { cols: 100, rows: 30, agentId: DEFAULT_AGENT } }]);
    expect(frames).toEqual([
      { type: "res", id: "open-1", ok: true, payload: { echo: "terminal.open" } },
      { type: "event", event: "terminal.data", payload: { sessionId: "s1", seq: 5, data: "hello" } },
    ]);
    ws.close();
  });

  it("queues requests sent before OpenClaw answers the dial", async () => {
    let release!: (value: { ws: WebSocket; scopes: Set<string> }) => void;
    const pending = new Promise<{ ws: WebSocket; scopes: Set<string> }>((resolve) => { release = resolve; });
    openUpstream.mockImplementationOnce(() => pending);
    const { ws, frames } = await openRelay();
    ws.send(JSON.stringify({ type: "req", id: "list-1", method: "terminal.list", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(upstreamReceived).toEqual([]);
    const real = new WebSocket(upstreamUrl);
    await new Promise<void>((resolve) => real.once("open", resolve));
    release({ ws: real, scopes });
    await vi.waitFor(() => expect(frames).toEqual([{ type: "res", id: "list-1", ok: true, payload: { echo: "terminal.list" } }]));
    ws.close();
  });

  it("answers a policy denial in place for a method outside the terminal family", async () => {
    const { ws, frames } = await openRelay();
    ws.send(JSON.stringify({ type: "req", id: "cfg-1", method: "config.get", params: {} }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({
      type: "res", id: "cfg-1", ok: false,
      error: { code: "POLICY_DENIED", message: "Octogee policy denied this terminal operation (method-unavailable)" },
    });
    expect(upstreamReceived).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("closes the relay on a frame that is not a request", async () => {
    const { ws, closed } = await openRelay();
    ws.send("garbage");
    expect(await closed).toBe(1008);
    expect(upstreamReceived).toEqual([]);
  });

  it("refuses a native user whose OpenClaw connection lacks the admin scope", async () => {
    scopes = new Set(["operator.read", "operator.write"]);
    const { closed } = await openRelay();
    expect(await closed).toBe(1008);
    expect(logged).toContain("terminal upstream lacks admin scope");
    await vi.waitFor(() => expect(upstream.clients.size).toBe(0));
  });

  it("closes the relay when the OpenClaw dial fails", async () => {
    openUpstream.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { closed } = await openRelay();
    expect(await closed).toBe(1011);
    expect(logged).toContain("terminal upstream dial failed");
  });

  it("closes an open relay once native admin access is revoked", async () => {
    const { ws, closed } = await openRelay();
    ws.send(JSON.stringify({ type: "req", id: "list-1", method: "terminal.list", params: {} }));
    await vi.waitFor(() => expect(upstreamReceived).toHaveLength(1));
    reauthorize.mockResolvedValue(false);
    expect(await closed).toBe(1008);
    expect(logged).toContain("terminal authorization ended");
    await vi.waitFor(() => expect(upstream.clients.size).toBe(0));
  });

  it("closes the browser when OpenClaw drops the native connection", async () => {
    const { closed } = await openRelay();
    await vi.waitFor(() => expect(upstream.clients.size).toBe(1));
    for (const client of upstream.clients) client.close(1001, "gateway restarting");
    expect(await closed).toBe(1001);
  });

  it("releases the OpenClaw connection when the browser leaves", async () => {
    const { ws } = await openRelay();
    await vi.waitFor(() => expect(upstream.clients.size).toBe(1));
    ws.close();
    await vi.waitFor(() => expect(upstream.clients.size).toBe(0));
  });
});
