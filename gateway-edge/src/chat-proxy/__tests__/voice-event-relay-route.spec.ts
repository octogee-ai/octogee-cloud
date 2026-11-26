import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => Promise<void> | void> = [];
const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  if (previousGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
  vi.resetModules();
});

async function startServer() {
  process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
  vi.resetModules();
  const { chatProxyHandleRequest } = await import("../proxy.js");
  const server = http.createServer((req, res) => {
    void chatProxyHandleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("chat proxy voice event relay route", () => {
  it("accepts an authenticated loopback plugin heartbeat on the gateway HTTP server", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/internal/openclaw/voice/v1/events`, {
      method: "POST",
      headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, agentId: "mom-coach", kind: "ready", ts: 1 }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, listening: false });
  });
});
