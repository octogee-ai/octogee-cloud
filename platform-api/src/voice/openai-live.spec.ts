import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createOpenAiLiveUpgradeHandler } from "./openai-live.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => server.close());
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function setup(options: { allowed?: boolean; key?: string | null } = {}) {
  const vendor = http.createServer();
  const vendorWs = new WebSocketServer({ server: vendor });
  const requests: http.IncomingMessage[] = [];
  const frames: string[] = [];
  vendorWs.on("connection", (ws, req) => {
    requests.push(req);
    ws.on("message", (raw) => { frames.push(raw.toString()); ws.send(raw.toString()); });
  });
  const upstreamUrl = await listen(vendor);
  const authorize = vi.fn(async () => options.allowed === false
    ? { ok: false as const, status: 403 as const }
    : { ok: true as const, gatewayId: "gw-a" });
  const handler = createOpenAiLiveUpgradeHandler({
    apiKey: options.key === undefined ? "platform-secret" : options.key,
    authorize, upstreamUrl, log: vi.fn(),
  });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { handler(req, socket, head); });
  const base = await listen(server);
  cleanups.push(() => { vendorWs.clients.forEach((ws) => ws.terminate()); vendorWs.close(); });
  return { base, requests, frames, authorize };
}
const start = { type: "session.start", session: { model: "gpt-live-1", delegation: { type: "client" } } };

describe("brokered native OpenAI Live transport", () => {
  it("keeps the platform key on the server and carries native frames in both directions", async () => {
    const test = await setup();
    const client = new WebSocket(`${test.base}/internal/voice/openai/live?gatewayId=gw-a`);
    cleanups.push(() => client.terminate());
    await once(client, "open");
    const received = once(client, "message");
    client.send(JSON.stringify(start));
    expect((await received)[0].toString()).toBe(JSON.stringify(start));
    expect(test.requests[0].headers.authorization).toBe("Bearer platform-secret");
    expect(test.requests[0].url).toBe("/");
    expect(test.frames).toEqual([JSON.stringify(start)]);
  });

  it("denies unauthenticated and cross-gateway callers before contacting OpenAI", async () => {
    for (const options of [{ allowed: false }, {}]) {
      const test = await setup(options);
      const client = new WebSocket(`${test.base}/internal/voice/openai/live?gatewayId=gw-other`);
      expect((await once(client, "error"))[0].message).toMatch(/403/);
      expect(test.requests).toHaveLength(0);
    }
  });

  it("releases gateway capacity after rejected WebSocket handshakes", async () => {
    const test = await setup();
    const url = `${test.base.replace('ws:', 'http:')}/internal/voice/openai/live?gatewayId=gw-a`;
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'invalid' } }, response => {
          expect(response.statusCode).toBe(400); response.resume();
        });
        req.on('socket', socket => socket.on('close', () => resolve())); req.on('error', reject);
      });
    }
    const client = new WebSocket(`${test.base}/internal/voice/openai/live?gatewayId=gw-a`);
    cleanups.push(() => client.terminate()); await once(client, 'open');
    const received = once(client, 'message'); client.send(JSON.stringify(start));
    expect((await received)[0].toString()).toBe(JSON.stringify(start));
  });
  it("bounds concurrent funded sessions and releases capacity on close", async () => {
    const test = await setup(); const url = `${test.base}/internal/voice/openai/live?gatewayId=gw-a`;
    const clients: WebSocket[] = [];
    for (let i = 0; i < 4; i++) { const client = new WebSocket(url); cleanups.push(() => client.terminate()); await once(client, 'open'); clients.push(client); }
    const denied = new WebSocket(url); expect((await once(denied, 'error'))[0].message).toMatch(/503/);
    clients[0].close(); await once(clients[0], 'close');
    const replacement = new WebSocket(url); cleanups.push(() => replacement.terminate()); await once(replacement, 'open');
  });

  it("rejects unsupported models and a missing platform key", async () => {
    const test = await setup();
    const client = new WebSocket(`${test.base}/internal/voice/openai/live?gatewayId=gw-a`);
    cleanups.push(() => client.terminate());
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({ ...start, session: { ...start.session, model: "gpt-live-1-codex" } }));
    expect((await closed)[0]).toBe(1008);
    expect(test.frames).toHaveLength(0);
    const unavailable = await setup({ key: null });
    const denied = new WebSocket(`${unavailable.base}/internal/voice/openai/live?gatewayId=gw-a`);
    expect((await once(denied, "error"))[0].message).toMatch(/503/);
    expect(unavailable.requests).toHaveLength(0);
  });
});
