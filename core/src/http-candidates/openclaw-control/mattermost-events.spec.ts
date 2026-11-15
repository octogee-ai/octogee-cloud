import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { watchMattermostChannelEvents } from "./mattermost-events.js";

const channelId = "a".repeat(26);
const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function fixture() {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const connected = new Promise<{ socket: WebSocket; auth: Promise<string> }>((resolve) => server.once("connection", (socket) => {
    const auth = new Promise<string>((received) => socket.once("message", (data) => received(data.toString())));
    resolve({ socket, auth });
  }));
  const controller = new AbortController();
  const changed = vi.fn();
  const running = watchMattermostChannelEvents({
    baseUrl: "http://mattermost.octogee-test.svc.cluster.local:8065",
    token: "caller-token", channelId, signal: controller.signal, onChange: changed,
    createSocket: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
  });
  const { socket, auth: authMessage } = await connected;
  const auth = await authMessage;
  return { socket, controller, changed, running, auth };
}

describe("Mattermost Control UI change feed", () => {
  it("authenticates as the caller and invalidates only the selected channel without forwarding content", async () => {
    const test = await fixture();
    expect(JSON.parse(test.auth)).toEqual({ seq: 1, action: "authentication_challenge", data: { token: "caller-token" } });
    test.socket.send(JSON.stringify({ seq_reply: 1, status: "OK" }));
    await vi.waitFor(() => expect(test.changed).toHaveBeenCalledTimes(1));
    test.socket.send(JSON.stringify({ event: "posted", broadcast: { channel_id: "b".repeat(26) }, data: { post: "private" } }));
    test.socket.send(JSON.stringify({ event: "posted", broadcast: { channel_id: channelId }, data: { post: "message-content" } }));
    test.socket.send(JSON.stringify({ event: "post_edited", broadcast: { channel_id: channelId } }));
    test.socket.send(JSON.stringify({ event: "post_deleted", broadcast: { channel_id: channelId } }));
    await vi.waitFor(() => expect(test.changed).toHaveBeenCalledTimes(4));
    expect(test.changed.mock.calls.every((args) => args.length === 0)).toBe(true);
    test.controller.abort();
    await test.running;
  });
  it("reports a failed feed instead of leaving history silently stale", async () => {
    const test = await fixture();
    const rejected = expect(test.running).rejects.toThrow(/authentication/);
    test.socket.send(JSON.stringify({ seq_reply: 1, status: "FAIL" }));
    await rejected;
    expect(test.changed).not.toHaveBeenCalled();
  });
  it("rejects off-cluster URLs before opening a socket", async () => {
    const createSocket = vi.fn();
    await expect(watchMattermostChannelEvents({ baseUrl: "https://evil.test", token: "secret", channelId,
      signal: new AbortController().signal, onChange: vi.fn(), createSocket })).rejects.toThrow(/URL/);
    expect(createSocket).not.toHaveBeenCalled();
  });
});
