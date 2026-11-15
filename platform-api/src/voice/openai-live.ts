import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceRelayUpgradeAuth } from "./relay.js";

export const OPENAI_LIVE_RELAY_PATH = "/internal/voice/openai/live";
export const OPENAI_LIVE_MODEL = "gpt-live-1";
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_SESSIONS_PER_GATEWAY = 4;

interface LiveRelayDeps {
  apiKey: string | null;
  authorize: (req: IncomingMessage) => Promise<VoiceRelayUpgradeAuth>;
  upstreamUrl?: string;
  log: (message: string, fields: Record<string, unknown>) => void;
}

function refuse(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Service Unavailable"}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function validStart(value: unknown): boolean {
  const event = value as { type?: unknown; session?: { model?: unknown; delegation?: { type?: unknown } } } | null;
  return event?.type === "session.start" && event.session?.model === OPENAI_LIVE_MODEL &&
    event.session.delegation?.type === "client";
}

export function createOpenAiLiveUpgradeHandler(deps: LiveRelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sessions = new Map<string, number>();
  const admit = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let release: (() => void) | undefined;
    try {
      const auth = await deps.authorize(req);
      const url = new URL(req.url ?? "/", "https://relay.local");
      if (!auth.ok || url.searchParams.get("gatewayId") !== auth.gatewayId) {
        refuse(socket, auth.ok ? 403 : auth.status);
        return;
      }
      if (!deps.apiKey || (sessions.get(auth.gatewayId) ?? 0) >= MAX_SESSIONS_PER_GATEWAY) {
        refuse(socket, 503);
        return;
      }
      if (socket.destroyed) return;
      const gatewayId = auth.gatewayId;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        const count = (sessions.get(gatewayId) ?? 1) - 1;
        if (count > 0) sessions.set(gatewayId, count);
        else sessions.delete(gatewayId);
      };
      socket.once("close", release);
      socket.once("error", release);
      sessions.set(gatewayId, (sessions.get(gatewayId) ?? 0) + 1);
      wss.handleUpgrade(req, socket, head, (client) => {
        const upstream = new WebSocket(deps.upstreamUrl ?? "wss://api.openai.com/v1/live/sessions", {
          headers: { Authorization: `Bearer ${deps.apiKey}` },
          maxPayload: MAX_FRAME_BYTES,
          handshakeTimeout: 10_000,
        });
        let closed = false;
        let started = false;
        let pendingBytes = 0;
        const pending: string[] = [];
        const timer = setTimeout(() => finish(1000, "session expired"), 30 * 60_000);
        timer.unref();
        const startupTimer = setTimeout(() => {
          if (!started) finish(1008, "session start required");
        }, 10_000);
        startupTimer.unref();
        const finish = (code: number, reason: string) => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          clearTimeout(startupTimer);
          release?.();
          pending.length = 0;
          client.close(code, reason);
          if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
          else upstream.close(1000, "relay closed");
        };
        client.on("message", (raw, binary) => {
          if (closed) return;
          const text = raw.toString();
          let event: { type?: unknown; session?: { model?: unknown } };
          try { event = JSON.parse(text); }
          catch { finish(1008, "invalid native frame"); return; }
          if (binary || !event || typeof event.type !== "string" ||
            (!started && !validStart(event)) ||
            (started && (event.type === "session.start" || event.session?.model !== undefined))) {
            finish(1008, "invalid native session");
            return;
          }
          started = true;
          clearTimeout(startupTimer);
          if (upstream.readyState === WebSocket.OPEN) {
            if (upstream.bufferedAmount > MAX_PENDING_BYTES) finish(1013, "voice transport overloaded");
            else upstream.send(text);
          } else {
            pendingBytes += Buffer.byteLength(text);
            if (pendingBytes > MAX_PENDING_BYTES) finish(1013, "voice transport overloaded");
            else pending.push(text);
          }
        });
        upstream.on("open", () => {
          if (closed) { upstream.close(); return; }
          for (const text of pending) upstream.send(text);
          pending.length = 0;
          pendingBytes = 0;
        });
        upstream.on("message", (raw, binary) => {
          if (closed) return;
          if (client.bufferedAmount > MAX_PENDING_BYTES) finish(1013, "voice transport overloaded");
          else client.send(raw, { binary });
        });
        upstream.on("error", () => {
          if (closed) return;
          deps.log("native OpenAI voice upstream failed", { gatewayId });
          finish(1011, "OpenAI voice unavailable");
        });
        upstream.on("close", () => finish(1000, "OpenAI voice closed"));
        client.on("close", () => finish(1000, "client closed"));
        client.on("error", () => finish(1011, "client transport failed"));
      });
    } catch (error) {
      release?.();
      deps.log("native OpenAI voice admission failed", { error: error instanceof Error ? error.message : String(error) });
      if (!socket.destroyed) refuse(socket, 503);
    }
  };
  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (new URL(req.url ?? "/", "https://relay.local").pathname !== OPENAI_LIVE_RELAY_PATH) return false;
    void admit(req, socket, head);
    return true;
  };
}
