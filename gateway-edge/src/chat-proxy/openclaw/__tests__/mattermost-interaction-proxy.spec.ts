import { signingKey as ROUTER_KEY, verificationKey } from "../../../test-setup/signature-keys.js";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { signAgentControlRouterRequest } from "@octogee/core/http-candidates/agent-control-callback-router";
import { createMattermostInteractionProxyHandler } from "../mattermost-interaction-proxy.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("stable Mattermost interaction proxy", () => {
  it("verifies the router proof before forwarding to loopback OpenClaw", async () => {
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe("/mattermost/interactions/default");
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("missing address");

    const now = 1_800_000_000_000;
    const body = Buffer.from('{"context":{}}');
    const handler = createMattermostInteractionProxyHandler({
      gatewayId: "walter",
      routerPublicKey: verificationKey,
      now: () => now,
      targetOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      log: () => undefined,
    });
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const signature = signAgentControlRouterRequest(body, "walter", String(now), ROUTER_KEY);

    const response = await fetch(`http://127.0.0.1:${address.port}/internal/openclaw/mattermost/interactions/default`, {
      method: "POST",
      headers: {
        "x-octogee-agent-control-gateway": "walter",
        "x-octogee-agent-control-timestamp": String(now),
        "x-octogee-agent-control-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("bounds loopback response size", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(65 * 1024));
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("missing address");
    const now = 1_800_000_000_000;
    const body = Buffer.from("{}");
    const handler = createMattermostInteractionProxyHandler({
      gatewayId: "walter",
      routerPublicKey: verificationKey,
      now: () => now,
      targetOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      maxResponseBytes: 64 * 1024,
      log: () => undefined,
    });
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const signature = signAgentControlRouterRequest(body, "walter", String(now), ROUTER_KEY);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/internal/openclaw/mattermost/interactions/default`,
      {
        method: "POST",
        headers: {
          "x-octogee-agent-control-gateway": "walter",
          "x-octogee-agent-control-timestamp": String(now),
          "x-octogee-agent-control-signature": signature,
        },
        body,
      },
    );
    expect(response.status).toBe(502);
  });
});
