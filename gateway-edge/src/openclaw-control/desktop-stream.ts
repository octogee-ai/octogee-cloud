import { randomUUID } from "node:crypto";
import { createWebSocketStream, WebSocket } from "ws";
import type { OpenClawControlSession } from "@octogee/core/http-candidates/openclaw-control/session";

type Binding = Pick<OpenClawControlSession, "sessionId" | "gatewayId" | "revisionId">;
type Ticket = Binding & { path: string; expiresAt: number };

export class DesktopObserverTickets {
  private readonly pending = new Map<string, Ticket>();
  constructor(private readonly now = Date.now) {}

  project(frame: Record<string, unknown>, session: Binding): Record<string, unknown> {
    if (frame.type !== "res" || frame.ok !== true) return frame;
    const payload = frame.payload as Record<string, unknown> | undefined;
    if (!payload || payload.transport !== "rfb" || typeof payload.wsPath !== "string" ||
      !/^\/desktop\/observe\?token=[A-Za-z0-9_-]+$/.test(payload.wsPath) ||
      typeof payload.expiresAtMs !== "number" || !Number.isFinite(payload.expiresAtMs)) {
      throw new Error("OpenClaw returned an invalid desktop observer response");
    }
    this.sweep();
    if (this.pending.size >= 128) throw new Error("Too many unclaimed desktop observers");
    const token = randomUUID();
    this.pending.set(token, {
      ...session, path: payload.wsPath, expiresAt: Math.min(payload.expiresAtMs, this.now() + 30_000),
    });
    const timer = setTimeout(() => this.pending.delete(token), 30_000);
    timer.unref();
    return { ...frame, payload: { ...payload, wsPath: `/g/${session.gatewayId}/openclaw/desktop/observe?token=${token}` } };
  }

  redeem(token: string, session: Binding): string | null {
    this.sweep();
    const ticket = this.pending.get(token);
    if (!ticket || ticket.sessionId !== session.sessionId || ticket.gatewayId !== session.gatewayId ||
      ticket.revisionId !== session.revisionId) return null;
    this.pending.delete(token);
    return ticket.path;
  }

  private sweep(): void {
    for (const [token, ticket] of this.pending) {
      if (ticket.expiresAt <= this.now()) this.pending.delete(token);
    }
  }
}

export function bridgeDesktopObserver(options: {
  browser: WebSocket;
  upstreamUrl: URL;
  authorize: () => Promise<boolean>;
  touch: () => boolean;
  release: () => void;
  log: (message: string) => void;
  authorizationIntervalMs: number;
}): void {
  const upstream = new WebSocket(options.upstreamUrl, { handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
  let closed = false;
  let checking = false;
  const release = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    options.release();
  };
  for (const [source, target] of [[options.browser, upstream], [upstream, options.browser]]) {
    source.once("close", (code, reason) => {
      release();
      if (target.readyState === WebSocket.CONNECTING || code === 1006) target.terminate();
      else target.close(code === 1005 ? undefined : code, reason);
    });
  }
  const browserStream = createWebSocketStream(options.browser);
  const upstreamStream = createWebSocketStream(upstream);
  const close = () => {
    release();
    browserStream.destroy();
    upstreamStream.destroy();
  };
  const fail = () => {
    options.log("OpenClaw desktop stream failed");
    close();
  };
  options.browser.prependListener("message", () => {
    if (!closed && !options.touch()) {
      options.log("OpenClaw desktop stream session expired");
      close();
    }
  });
  const timer = setInterval(() => {
    if (checking || closed) return;
    checking = true;
    void options.authorize().then((allowed) => {
      if (!allowed) {
        options.log("OpenClaw desktop stream authorization revoked");
        close();
      }
    }).catch(fail).finally(() => { checking = false; });
  }, options.authorizationIntervalMs);
  timer.unref();
  for (const stream of [browserStream, upstreamStream]) {
    stream.on("error", fail);
  }
  browserStream.pipe(upstreamStream).pipe(browserStream);
}
