import { WebSocket, type ClientOptions } from "ws";

const CHANGE_EVENTS = new Set(["posted", "post_edited", "post_deleted"]);

export async function watchMattermostChannelEvents(input: {
  baseUrl: string;
  token: string;
  channelId: string;
  signal: AbortSignal;
  onChange: () => void;
  createSocket?: (url: string, options: ClientOptions) => WebSocket;
}): Promise<void> {
  const url = new URL(input.baseUrl);
  if (url.protocol !== "http:" || !/^mattermost\.[a-z0-9-]+\.svc\.cluster\.local$/u.test(url.hostname) ||
    url.port !== "8065" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Invalid Mattermost event URL");
  }
  if (!/^[a-z0-9]{26}$/u.test(input.channelId)) throw new Error("Invalid Mattermost event channel");
  if (input.signal.aborted) return;
  url.protocol = "ws:";
  url.pathname = "/api/v4/websocket";
  const socket = (input.createSocket ?? ((target, options) => new WebSocket(target, options)))(url.href, {
    maxPayload: 1024 * 1024, handshakeTimeout: 10_000,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let authenticated = false;
    let alive = true;
    const authTimer = setTimeout(() => finish(new Error("Mattermost event authentication timed out")), 10_000);
    const heartbeat = setInterval(() => {
      if (!alive) { finish(new Error("Mattermost event heartbeat timed out")); return; }
      alive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    authTimer.unref();
    heartbeat.unref();
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      input.signal.removeEventListener("abort", aborted);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate();
      if (error) reject(error); else resolve();
    }
    function aborted(): void { finish(); }
    input.signal.addEventListener("abort", aborted, { once: true });
    socket.once("open", () => socket.send(JSON.stringify({
      seq: 1, action: "authentication_challenge", data: { token: input.token },
    })));
    socket.on("pong", () => { alive = true; });
    socket.once("error", () => finish(new Error("Mattermost event transport failed")));
    socket.once("close", () => finish(new Error("Mattermost event transport closed")));
    socket.on("message", (data) => {
      if (settled) return;
      let event;
      try { event = JSON.parse(data.toString()); }
      catch { finish(new Error("Mattermost event was invalid")); return; }
      if (!event || typeof event !== "object") { finish(new Error("Mattermost event was invalid")); return; }
      if (event.seq_reply === 1) {
        if (event.status !== "OK") { finish(new Error("Mattermost event authentication failed")); return; }
        authenticated = true;
        clearTimeout(authTimer);
        input.onChange();
      } else if (authenticated && CHANGE_EVENTS.has(event.event) && event.broadcast?.channel_id === input.channelId) {
        input.onChange();
      }
    });
    if (input.signal.aborted) finish();
  });
}
