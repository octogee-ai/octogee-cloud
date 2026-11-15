import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";

import { WsUpgradeAuthorizationError, WsUpgradeRouter } from "./upgrade-router.js";

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    if (!s) continue;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function attempt(
  port: number,
  path: string,
  opts: { origin?: string; headers?: Record<string, string> } = {},
): Promise<{ ok: true; ws: WebSocket } | { ok: false; status: number; errorCode?: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.origin) headers.origin = opts.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once("open", () => resolve({ ok: true, ws }));
    ws.once("error", () => undefined); 
    ws.once("unexpected-response", (_req, res) => {
      resolve({
        ok: false,
        status: res.statusCode ?? 0,
        errorCode: typeof res.headers["x-octogee-ws-error"] === "string"
          ? res.headers["x-octogee-ws-error"]
          : undefined,
      });
    });
  });
}

describe("WsUpgradeRouter", () => {
  it("returns a bounded typed authorization failure without exposing implementation details", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dashboard",
      allowedOrigins: new Set(["https://api.example"]),
      authorize: async () => {
        throw new WsUpgradeAuthorizationError(504, "OPENCLAW_BROKER_TIMEOUT");
      },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const result = await attempt(port, "/dashboard", { origin: "https://api.example" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(504);
      expect(result.errorCode).toBe("OPENCLAW_BROKER_TIMEOUT");
    }
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("routes a matching path to its handler when Origin is allowed", async () => {
    const server = createServer();
    servers.push(server);
    const handlerCalls: string[] = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: "/test",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: ({ ticket }) => {
        handlerCalls.push(ticket ?? "(no ticket)");
      },
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/test", { origin: "https://app.example" });
    expect(r.ok).toBe(true);
    if (r.ok) r.ws.close();
    expect(handlerCalls).toEqual(["(no ticket)"]);
  });

  it("rejects with 403 when Origin is not in the allowlist", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/test",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/test", { origin: "https://evil.example" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects with 403 when Origin header is absent", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/test",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("supports prefix matching with extractTicket for ticketed routes", async () => {
    const server = createServer();
    servers.push(server);
    const handlerTickets: string[] = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: (p) => p.startsWith("/ticketed/"),
      extractTicket: (p) => {
        const m = p.match(/^\/ticketed\/([A-Za-z0-9_-]{8,32})\/?$/);
        return m ? m[1] : null;
      },
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: ({ ticket }) => {
        handlerTickets.push(ticket ?? "");
      },
    });
    router.attach(server);
    const port = await listen(server);
    const ticket = "abcdef0123456789xyzWVUTSR";
    const r = await attempt(port, `/ticketed/${ticket}`, { origin: "https://app.example" });
    expect(r.ok).toBe(true);
    if (r.ok) r.ws.close();
    expect(handlerTickets).toEqual([ticket]);
  });

  it("rejects with 400 when extractTicket returns null", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: (p) => p.startsWith("/ticketed/"),
      extractTicket: () => null,
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/ticketed/x", { origin: "https://app.example" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects an invalid route path before running authorization or upgrading", async () => {
    const server = createServer();
    servers.push(server);
    const authorize = vi.fn(async () => true);
    const router = new WsUpgradeRouter();
    router.add({
      match: (p) => p.startsWith("/dashboard/"),
      extractTicket: () => null,
      allowedOrigins: new Set(["https://app.example"]),
      authorize,
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);

    const result = await attempt(port, "/dashboard/invalid", {
      origin: "https://app.example",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("accepts a predicate function for dynamic Origin enforcement", async () => {
    const server = createServer();
    servers.push(server);
    const seen: Array<string | undefined> = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dyn",

allowedOrigins: (origin) => {
        seen.push(origin);
        return origin === "https://app.example";
      },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const ok = await attempt(port, "/dyn", { origin: "https://app.example" });
    expect(ok.ok).toBe(true);
    if (ok.ok) ok.ws.close();
    const bad = await attempt(port, "/dyn", { origin: "https://evil.example" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(403);
    expect(seen).toEqual(["https://app.example", "https://evil.example"]);
  });

  it("predicate function receives undefined when Origin header is missing", async () => {
    const server = createServer();
    servers.push(server);
    let seenOrigin: string | undefined = "not-called";
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dyn",
      allowedOrigins: (origin) => {
        seenOrigin = origin;
        return false;
      },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/dyn");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(seenOrigin).toBeUndefined();
  });

  it("allows `allowedOrigins: 'check-in-handler'` to bypass router-level Origin enforcement", async () => {

const server = createServer();
    servers.push(server);
    let handlerOrigin: string | undefined;
    const router = new WsUpgradeRouter();
    router.add({
      match: "/raw",
      allowedOrigins: "check-in-handler",
      onUpgrade: ({ req }) => {
        handlerOrigin = req.headers.origin as string | undefined;
      },
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/raw", { origin: "https://anywhere.example" });
    expect(r.ok).toBe(true);
    if (r.ok) r.ws.close();
    expect(handlerOrigin).toBe("https://anywhere.example");
  });

  it("requireHeaderKey rejects an oversized header without scanning all of it (length-mismatch fast-fails)", async () => {

const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/k",
      allowedOrigins: "check-in-handler",
      requireHeaderKey: { header: "x-internal-service-key", expected: "abc" },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);

const r = await attempt(port, "/k", {
      headers: { "x-internal-service-key": "a".repeat(2048) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it("enforces an authHeader allowlist (constant-time match) returning 401 on mismatch", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/internal",
      allowedOrigins: "check-in-handler",
      requireHeaderKey: { header: "x-internal-service-key", expected: "secret-xyz" },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const bad = await attempt(port, "/internal", { headers: { "x-internal-service-key": "wrong" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(401);
    const good = await attempt(port, "/internal", { headers: { "x-internal-service-key": "secret-xyz" } });
    expect(good.ok).toBe(true);
    if (good.ok) good.ws.close();
  });

  it("awaits route-specific authorization before accepting the WebSocket", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dashboard",
      allowedOrigins: new Set(["https://api.example"]),
      authorize: async (req) => req.headers.cookie === "session=valid",
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const bad = await attempt(port, "/dashboard", { origin: "https://api.example" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(401);
    const good = await attempt(port, "/dashboard", {
      origin: "https://api.example",
      headers: { cookie: "session=valid" },
    });
    expect(good.ok).toBe(true);
    if (good.ok) good.ws.close();
  });

  it("does not upgrade a browser socket that disconnects while authorization is pending", async () => {
    let resolveAuthorization!: (allowed: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      resolveAuthorization = resolve;
    });
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dashboard",
      allowedOrigins: new Set(["https://api.example"]),
      authorize: async () => authorization,
      onUpgrade: vi.fn(),
    });
    const compiled = (router as unknown as {
      routes: Array<{ wss: { handleUpgrade: ReturnType<typeof vi.fn> } }>;
    }).routes[0];
    compiled.wss.handleUpgrade = vi.fn();
    const socket = new PassThrough();
    router.dispatch({
      url: "/dashboard",
      headers: { origin: "https://api.example" },
    } as never, socket, Buffer.alloc(0));
    socket.destroy();
    resolveAuthorization(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(compiled.wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it("returns a retryable response and reports broker authorization failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/dashboard",
      allowedOrigins: new Set(["https://api.example"]),
      authorize: async () => { throw new Error("broker unavailable"); },
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const result = await attempt(port, "/dashboard", { origin: "https://api.example" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      severity: "ERROR", message: "WsUpgradeRouter route failed",
      error: { name: "Error", message: "broker unavailable" },
    });
    errorSpy.mockRestore();
  });

  it("first-match-wins across multiple registered routes", async () => {
    const server = createServer();
    servers.push(server);
    const calls: string[] = [];
    const router = new WsUpgradeRouter();
    router.add({
      match: "/ticketed/short-prefix",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => calls.push("short"),
    });
    router.add({
      match: (p) => p.startsWith("/ticketed/"),
      extractTicket: (p) => p.split("/")[2] ?? null,
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => calls.push("prefix"),
    });
    router.attach(server);
    const port = await listen(server);
    const r1 = await attempt(port, "/ticketed/short-prefix", { origin: "https://app.example" });
    if (r1.ok) r1.ws.close();
    const r2 = await attempt(port, "/ticketed/other-ticket", { origin: "https://app.example" });
    if (r2.ok) r2.ws.close();
    expect(calls).toEqual(["short", "prefix"]);
  });

  it("destroys the socket when no route matches (no 404 in the WS context — destroying signals 'wrong endpoint')", async () => {
    const server = createServer();
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/known",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const r = await attempt(port, "/unknown", { origin: "https://app.example" });
    expect(r.ok).toBe(false);
    
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("can be attached to a server that already has its own non-upgrade routes", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("ok");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    const router = new WsUpgradeRouter();
    router.add({
      match: "/ws",
      allowedOrigins: new Set(["https://app.example"]),
      onUpgrade: () => undefined,
    });
    router.attach(server);
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const ws = await attempt(port, "/ws", { origin: "https://app.example" });
    expect(ws.ok).toBe(true);
    if (ws.ok) ws.ws.close();
  });
});
