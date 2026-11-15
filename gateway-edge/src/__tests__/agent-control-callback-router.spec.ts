import { signingKey as ROUTER_KEY, verificationKey } from "../test-setup/signature-keys.js";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentControlCallbackRouter,
  signAgentControlRouterRequest,
  signMattermostCommandRequest,
  verifyAgentControlRouterRequest,
  verifyMattermostCommandRequest,
} from "@octogee/core/http-candidates/agent-control-callback-router";
import { createVmRoutesResolver } from "../vm-routes.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("private Mattermost callback router", () => {
  it("forwards the /ui slash command to the API with a command proof and relays the ephemeral reply", async () => {
    const seen: Array<{ url?: string; body: Buffer; headers: Record<string, unknown> }> = [];
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen.push({ url: req.url, body: Buffer.concat(chunks), headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"response_type":"ephemeral","text":"hi"}');
    });
    servers.push(api);
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const apiAddress = api.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("missing api address");
    const gatewayOrigin = vi.fn(() => "http://127.0.0.1:1");
    const router = createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: ROUTER_KEY,
      now: () => 1_000,
      targetOrigin: gatewayOrigin,
      apiOrigin: `http://127.0.0.1:${apiAddress.port}`,
      log: () => undefined,
    });
    servers.push(router);
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
    const address = router.address();
    if (!address || typeof address === "string") throw new Error("missing router address");
    const form = "token=command-token&team_id=t&user_id=u&command=%2Fui";

    const response = await fetch(`http://127.0.0.1:${address.port}/internal/mattermost/commands/control-ui`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-octogee-mattermost-command-signature": "f".repeat(128),
      },
      body: form,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_type: "ephemeral", text: "hi" });
    expect(gatewayOrigin).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const [delivery] = seen;
    expect(delivery!.url).toBe("/internal/mattermost/commands/control-ui");
    expect(delivery!.body.toString()).toBe(form);
    expect(delivery!.headers["x-octogee-agent-control-signature"]).toBeUndefined();
    const proof = {
      command: String(delivery!.headers["x-octogee-mattermost-command"]),
      timestamp: String(delivery!.headers["x-octogee-mattermost-command-timestamp"]),
      signature: String(delivery!.headers["x-octogee-mattermost-command-signature"]),
    };
    expect(proof.signature).not.toBe("f".repeat(128));
    expect(verifyMattermostCommandRequest(delivery!.body, proof, verificationKey, 1_000)).toBe(true);
    expect(verifyMattermostCommandRequest(Buffer.from(`${form}&x=1`), proof, verificationKey, 1_000)).toBe(false);
    expect(verifyMattermostCommandRequest(delivery!.body, proof, verificationKey, 1_000 + 31_000)).toBe(false);
  });

  it("keeps command proofs and gateway callback proofs from standing in for each other", () => {
    const body = Buffer.from("token=t");
    const gatewaySignature = signAgentControlRouterRequest(body, "walter", "1000", ROUTER_KEY);
    const commandSignature = signMattermostCommandRequest(body, "control-ui", "1000", ROUTER_KEY);

    expect(verifyMattermostCommandRequest(body, { command: "control-ui", timestamp: "1000", signature: gatewaySignature }, verificationKey, 1_000)).toBe(false);
    expect(verifyAgentControlRouterRequest(body, { gatewayId: "walter", timestamp: "1000", signature: commandSignature }, verificationKey, 1_000)).toBe(false);
    expect(verifyMattermostCommandRequest(body, { command: "other", timestamp: "1000", signature: commandSignature }, verificationKey, 1_000)).toBe(false);
  });

  it("routes signed callbacks to current VM entries and falls back to shared services after removal", async () => {
    const deliveries: string[] = [];
    const vm = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect(verifyAgentControlRouterRequest(Buffer.concat(chunks), {
        gatewayId: String(req.headers["x-octogee-agent-control-gateway"]),
        timestamp: String(req.headers["x-octogee-agent-control-timestamp"]),
        signature: String(req.headers["x-octogee-agent-control-signature"]),
      }, verificationKey, 1_000)).toBe(true);
      deliveries.push(req.url ?? "");
      res.end("vm");
    });
    const shared = createServer((_req, res) => res.end("shared"));
    servers.push(vm, shared);
    await Promise.all([vm, shared].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
    const vmAddress = vm.address();
    const sharedAddress = shared.address();
    if (!vmAddress || typeof vmAddress === "string" || !sharedAddress || typeof sharedAddress === "string") {
      throw new Error("missing upstream address");
    }
    let routes = '{"walter":"127.0.0.1"}';
    let mtime = 1;
    const resolveVmOrigin = createVmRoutesResolver({
      filePath: "/routes.json",
      edgePort: vmAddress.port,
      readFile: () => routes,
      mtimeOf: () => mtime,
      log: () => undefined,
      logInfo: () => undefined,
    });
    const sharedOrigin = vi.fn(() => `http://127.0.0.1:${sharedAddress.port}`);
    const router = createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: ROUTER_KEY,
      now: () => 1_000,
      resolveVmOrigin,
      targetOrigin: sharedOrigin,
      log: () => undefined,
    });
    servers.push(router);
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
    const address = router.address();
    if (!address || typeof address === "string") throw new Error("missing router address");
    const send = async (gatewayId: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/openclaw/mattermost/${gatewayId}/mattermost/interactions/default`, {
        method: "POST", body: '{"context":{"action":"approve"}}',
      });
      expect(response.status).toBe(200);
      return response.text();
    };
    expect(await send("walter")).toBe("vm");
    expect(sharedOrigin).not.toHaveBeenCalled();
    expect(deliveries).toEqual(["/api/g/walter/internal/openclaw/mattermost/interactions/default"]);
    expect(await send("shared-0")).toBe("shared");
    expect(sharedOrigin).toHaveBeenLastCalledWith("shared-0");
    routes = "{}";
    mtime += 1;
    expect(await send("walter")).toBe("shared");
    expect(sharedOrigin).toHaveBeenLastCalledWith("walter");
    expect(deliveries).toHaveLength(1);
  });

  it("forwards only explicit bounded routes to the stable gateway service and strips forged headers", async () => {
    const upstream = createServer((req, res) => {
      expect(req.url).toBe("/api/g/walter/internal/openclaw/mattermost/interactions/default");
      expect(req.headers["x-octogee-forged"]).toBeUndefined();
      expect(req.headers["x-octogee-agent-control-signature"]).toBeTypeOf("string");
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
        "proxy-authenticate": "forged",
      });
      res.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const router = createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: ROUTER_KEY,
      now: () => 1_000,
      targetOrigin: () => `http://127.0.0.1:${address.port}`,
      log: () => undefined,
    });
    servers.push(router);
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
    const routerAddress = router.address();
    if (!routerAddress || typeof routerAddress === "string") throw new Error("missing router address");

    const response = await fetch(
      `http://127.0.0.1:${routerAddress.port}/internal/openclaw/mattermost/walter/mattermost/interactions/default`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-octogee-forged": "yes" },
        body: '{"post_id":"post-1"}',
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("proxy-authenticate")).toBeNull();
  });

  it("bounds upstream latency and response size before writing downstream headers", async () => {
    const oversized = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(65 * 1024));
    });
    servers.push(oversized);
    await new Promise<void>((resolve) => oversized.listen(0, "127.0.0.1", resolve));
    const oversizedAddress = oversized.address();
    if (!oversizedAddress || typeof oversizedAddress === "string") throw new Error("missing address");
    const router = createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: ROUTER_KEY,
      targetOrigin: () => `http://127.0.0.1:${oversizedAddress.port}`,
      upstreamTimeoutMs: 50,
      maxResponseBytes: 64 * 1024,
      log: () => undefined,
    });
    servers.push(router);
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
    const address = router.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/openclaw/mattermost/walter/mattermost/interactions/default`,
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(502);

    const hanging = createServer(() => undefined);
    servers.push(hanging);
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hangingAddress = hanging.address();
    if (!hangingAddress || typeof hangingAddress === "string") throw new Error("missing address");
    const timeoutRouter = createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: ROUTER_KEY,
      targetOrigin: () => `http://127.0.0.1:${hangingAddress.port}`,
      upstreamTimeoutMs: 20,
      log: () => undefined,
    });
    servers.push(timeoutRouter);
    await new Promise<void>((resolve) => timeoutRouter.listen(0, "127.0.0.1", resolve));
    const timeoutAddress = timeoutRouter.address();
    if (!timeoutAddress || typeof timeoutAddress === "string") throw new Error("missing address");
    const timedOut = await fetch(
      `http://127.0.0.1:${timeoutAddress.port}/internal/openclaw/mattermost/walter/mattermost/interactions/default`,
      { method: "POST", body: "{}" },
    );
    expect(timedOut.status).toBe(502);
  });

  it("rejects unknown/public paths and verifies the router proof within 30 seconds", async () => {
    const router = createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: ROUTER_KEY,
      now: () => 1_000,
      targetOrigin: () => "http://127.0.0.1:1",
      log: () => undefined,
    });
    servers.push(router);
    await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
    const address = router.address();
    if (!address || typeof address === "string") throw new Error("missing router address");
    expect((await fetch(`http://127.0.0.1:${address.port}/api/openclaw/approval/callback`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${address.port}/internal/openclaw/agent-control/walter/callback`, { method: "POST" })).status).toBe(404);

    const body = Buffer.from('{"ok":true}');
    const proof = {
      gatewayId: "walter",
      timestamp: "1000",
      signature: "invalid",
    };
    expect(verifyAgentControlRouterRequest(body, proof, verificationKey, 1_000)).toBe(false);
    expect(verifyAgentControlRouterRequest(body, { ...proof, timestamp: "969" }, verificationKey, 1_000)).toBe(false);
    expect(() => createAgentControlCallbackRouter({
      namespace: "octogee-test",
      signingKey: "short",
      log: () => undefined,
    })).toThrow("AGENT_CONTROL_ROUTER_KEY");
  });
});
