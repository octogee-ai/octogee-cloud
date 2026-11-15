import type { RawData, WebSocket } from "ws";
import type { UpgradeGateVerdict } from "../../roll-roster.js";
import type { BridgeLog } from "@octogee/core/http/bridge-log";

// Close code signalling the client to reconnect (same signal the OC WS bridge
// uses for gatewayId changes); on reconnect the flipped Service selector /
// roster resolves the client to the current serving revision.
export const MM_WS_RECONNECT_CLOSE_CODE = 1001;

// Pre-admission DoS bounds. The bridge holds the upstream dial until the first
// authentication_challenge; without these an unauthenticated client could stream
// non-auth frames forever, buffering to memory pressure. The deadline closes a
// socket that never authenticates; the frame/byte caps bound the pre-open queue
// (worst-case memory ≈ MAX_PREAUTH_BYTES). MM's web client sends the auth
// challenge as its first frame, so legitimate traffic stays far under these.
export const PRE_AUTH_DEADLINE_MS = 10_000;
export const MAX_PREAUTH_FRAMES = 64;
export const MAX_PREAUTH_BYTES = 1_048_576;

// Post-auth admission bound. Once the first authentication_challenge resolves
// the MM user, the bridge awaits the roster verdict before dialing. That await
// must be bounded: a verdict (or token→user resolution) that never settles must
// fail CLOSED here, not hold the socket open until the client's own handshake
// timeout. Shorter than the PWA's 15s handshake window so the client gets the
// reconnect signal and retries against the serving revision instead of looping.
export const ADMISSION_DEADLINE_MS = 5_000;

const ADMISSION_TIMEOUT: unique symbol = Symbol("mm-ws-admission-timeout");

export interface MmWsProxyDeps {
  
  mmInternalWsUrl: string;
  log: BridgeLog;

resolveMmUserId: (mmToken: string) => Promise<string | null>;
  
  openUpstream: (url: string) => WebSocket;

  // Roll-roster verdict for the authenticated MM user (Codex P0 — the
  // auth-late seam). MM identity only exists once the first
  // authentication_challenge frame resolves, so the upstream MM socket is NOT
  // dialed at attach: the bridge holds, resolves the token → MM user, awaits
  // this verdict (the SAME shared upgrade-gate policy — no MM-specific fork),
  // and only then dials — or closes the client with the reconnect code.
  // Absent → always allow (legacy pods, cluster surface).
  rosterVerdict?: (mmUserId: string | null) => Promise<UpgradeGateVerdict> | UpgradeGateVerdict;

registry?: MmWsRegistry;
  now?: () => number;

ackResolutionTimeoutMs?: number;

  // Deadline for the post-auth admission (token→user + roster verdict) before
  // failing CLOSED. Defaults to ADMISSION_DEADLINE_MS.
  admissionDeadlineMs?: number;

  // Pre-admission DoS bounds (default to the module constants). A socket that
  // sends no authentication_challenge within preAuthDeadlineMs is closed; the
  // pre-open queue is capped at maxPreAuthFrames frames / maxPreAuthBytes bytes.
  preAuthDeadlineMs?: number;
  maxPreAuthFrames?: number;
  maxPreAuthBytes?: number;
}

export interface MmWsBridge {
  
  close: () => void;
}

interface RegistryConn {
  send: (frame: string) => void;
  getMmUserId: () => string | null;
}

export interface MmWsRegistry {
  add: (send: (frame: string) => void, getMmUserId: () => string | null) => () => void;

broadcast: (frame: unknown, isAllowed?: (mmUserId: string | null) => boolean) => void;
}

export function createMmWsRegistry(): MmWsRegistry {
  const conns = new Set<RegistryConn>();
  return {
    add(send, getMmUserId) {
      const conn: RegistryConn = { send, getMmUserId };
      conns.add(conn);
      return () => conns.delete(conn);
    },
    broadcast(frame, isAllowed) {
      const json = JSON.stringify(frame);
      for (const conn of conns) {
        if (isAllowed) {
          const uid = conn.getMmUserId();

if (uid === null || !isAllowed(uid)) continue;
        }
        try {
          conn.send(json);
        } catch {
          // a dead socket must not abort the fan-out
        }
      }
    },
  };
}

export interface AckFrame {
  event: "octogee_ack";
  data: {
    postId: string;
    channelId: string;
    receivedAt: number;
  };
}

export function attachMmWsBridge(
  deps: MmWsProxyDeps,
  browserWs: WebSocket,
): MmWsBridge {
  const now = deps.now ?? Date.now;
  const ackResolutionTimeoutMs = deps.ackResolutionTimeoutMs ?? 2_000;
  const admissionDeadlineMs = deps.admissionDeadlineMs ?? ADMISSION_DEADLINE_MS;
  const preAuthDeadlineMs = deps.preAuthDeadlineMs ?? PRE_AUTH_DEADLINE_MS;
  const maxPreAuthFrames = deps.maxPreAuthFrames ?? MAX_PREAUTH_FRAMES;
  const maxPreAuthBytes = deps.maxPreAuthBytes ?? MAX_PREAUTH_BYTES;
  // Dialed only after the roster verdict admits the authenticated user.
  let upstream: WebSocket | null = null;
  let mmUserId: string | null = null;
  let pendingMmUserId: Promise<string | null> | null = null;
  let closed = false;
  let upstreamOpen = false;
  let admissionStarted = false;
  const browserOutbox: Array<{ frame: RawData; binary: boolean }> = [];
  let queuedBytes = 0;
  let authDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let inboundChain: Promise<void> = Promise.resolve();

  const unregister = deps.registry?.add(
    (frame: string) => {
      if (closed || browserWs.readyState !== 1) return;
      browserWs.send(frame);
    },
    () => mmUserId,
  );

  const clearAuthDeadline = () => {
    if (authDeadlineTimer) {
      clearTimeout(authDeadlineTimer);
      authDeadlineTimer = null;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearAuthDeadline();
    unregister?.();
    safeClose(browserWs);
    if (upstream) safeClose(upstream);
  };

  // The single pre-admission refusal: signal the client to reconnect (the SAME
  // code the roster refusal uses) and tear down.
  const closeWithReconnect = (reason: string) => {
    if (closed) return;
    deps.log(`[mm-proxy/ws] ${reason} (mmUserId=${mmUserId ?? "unknown"}) — closing`, "warn");
    try {
      browserWs.close(MM_WS_RECONNECT_CLOSE_CODE, reason);
    } catch {
      /* close() below tears down regardless */
    }
    close();
  };

  // Enqueue a pre-open frame, enforcing the DoS caps. Trips (and closes) when
  // either the frame count or the byte total exceeds its bound.
  const queuePreOpen = (frame: RawData, binary: boolean): void => {
    browserOutbox.push({ frame, binary });
    queuedBytes += frameByteLength(frame);
    if (browserOutbox.length > maxPreAuthFrames) {
      closeWithReconnect("preauth_frame_cap_exceeded");
    } else if (queuedBytes > maxPreAuthBytes) {
      closeWithReconnect("preauth_byte_cap_exceeded");
    }
  };

  authDeadlineTimer = setTimeout(() => {
    if (closed || admissionStarted) return;
    closeWithReconnect("auth_deadline_exceeded");
  }, preAuthDeadlineMs);
  authDeadlineTimer.unref?.();

const logClose = (side: "browser" | "upstream", code: number, reason: unknown) => {
    if (closed) return;
    deps.log(
      `[mm-proxy/ws] ${side} close code=${code ?? "?"} reason=${reasonToStr(reason)} mmUserId=${mmUserId ?? "unknown"}`,
    );
  };

  const flushOutbox = () => {
    if (!upstreamOpen || !upstream) return;
    while (browserOutbox.length > 0) {
      const queued = browserOutbox.shift();
      if (queued === undefined) break;
      queuedBytes -= frameByteLength(queued.frame);
      try {
        upstream.send(queued.frame, { binary: queued.binary });
      } catch (err) {
        deps.log(`[mm-proxy/ws] flushOutbox send failed: ${(err as Error).message}`, "warn");
        return;
      }
    }
  };

  const dialUpstream = () => {
    const up = deps.openUpstream(deps.mmInternalWsUrl);
    upstream = up;
    up.on("open", () => {
      upstreamOpen = true;
      deps.log(`[mm-proxy/ws] upstream open (mmUserId=${mmUserId ?? "unknown"})`);
      flushOutbox();
    });
    up.on("message", (data: RawData, isBinary: boolean) => {
      inboundChain = inboundChain.then(async () => {
        let effectiveUserId = mmUserId;
        if (!effectiveUserId && pendingMmUserId) {
          effectiveUserId = await resolvePendingMmUserId(pendingMmUserId, ackResolutionTimeoutMs);
        }
        if (closed || browserWs.readyState !== 1) return;
        const ack = buildAckIfUserPost(data, effectiveUserId ?? mmUserId, now);
        if (ack) {
          try {
            browserWs.send(JSON.stringify(ack));
          } catch (err) {
            deps.log(`[mm-proxy/ws] ack inject failed: ${(err as Error).message}`, "warn");
          }
        }
        try {
          browserWs.send(data, { binary: isBinary });
        } catch (err) {
          deps.log(`[mm-proxy/ws] downstream forward failed: ${(err as Error).message}`, "warn");
        }
      });
    });
    up.on("close", (code: number, reason: unknown) => {
      logClose("upstream", code, reason);
      close();
    });
    up.on("error", (err: Error) =>
      deps.log(`[mm-proxy/ws] upstream error: ${err.message}`, "warn"),
    );
  };

  // Await the token→user resolution, then the roster verdict. Absent verdict
  // (legacy pod / cluster surface) admits unconditionally.
  const resolveVerdict = async (): Promise<UpgradeGateVerdict> => {
    if (pendingMmUserId) await pendingMmUserId;
    if (closed || upstream || !deps.rosterVerdict) return { allow: true };
    return deps.rosterVerdict(mmUserId);
  };

  // Runs once, on the first authentication_challenge: resolve the verdict, THEN
  // dial — never fire-and-forget. The resolution is raced against a deadline: a
  // verdict (or token→user resolution) that never settles fails CLOSED here
  // rather than holding the socket silently (no-silent-failures). Every refusal
  // closes the client with the reconnect code; the retrying client resolves to
  // the serving revision.
  const runAdmission = async () => {
    const deadline = makeAdmissionDeadline(admissionDeadlineMs);
    let outcome: UpgradeGateVerdict | typeof ADMISSION_TIMEOUT;
    try {
      outcome = await Promise.race([resolveVerdict(), deadline.promise]);
    } catch (err) {
      deps.log(`[mm-proxy/ws] roster verdict failed (failing CLOSED): ${errorToStr(err)}`, "warn");
      outcome = { allow: false, reason: "roster-verdict-failed" };
    } finally {
      deadline.cancel();
    }
    if (closed || upstream) return;
    if (outcome === ADMISSION_TIMEOUT) {
      closeWithReconnect("admission_deadline_exceeded");
      return;
    }
    if (!outcome.allow) {
      deps.log(`[mm-proxy/ws] roll roster refused MM WS (mmUserId=${mmUserId ?? "unknown"}): ${outcome.reason}`, "warn");
      try {
        browserWs.close(MM_WS_RECONNECT_CLOSE_CODE, `gateway_revision_unavailable:${outcome.reason}`);
      } catch {
        /* close() below tears down regardless */
      }
      close();
      return;
    }
    dialUpstream();
  };

browserWs.on("message", (data: RawData, isBinary: boolean) => {
    const isAuth = isAuthChallengeFrame(data);
    if (isAuth && !mmUserId && !pendingMmUserId) {
      pendingMmUserId = maybeCaptureMmTokenForAuth(data, deps.resolveMmUserId)
        .then((resolvedId) => {
          if (resolvedId && !mmUserId) {
            mmUserId = resolvedId;
            deps.log(`[mm-proxy/ws] authenticated mmUserId=${resolvedId}`);
          }
          return resolvedId ?? null;
        })
        .catch((err: unknown) => {
          deps.log(`[mm-proxy/ws] resolveMmUserId rejected: ${errorToStr(err)}`, "warn");
          return null;
        })
        .finally(() => {
          pendingMmUserId = null;
        });
    }
    if (!upstream) {
      // Pre-admission: everything queues (the auth frame included) exactly as
      // pre-open frames always have; the flush preserves order + opcode. The
      // caps bound the queue against a client that never authenticates.
      queuePreOpen(data, isBinary);
      if (isAuth && !admissionStarted && !closed) {
        admissionStarted = true;
        clearAuthDeadline();
        void runAdmission();
      }
      return;
    }
    if (upstreamOpen && upstream.readyState === 1 ) {
      upstream.send(data, { binary: isBinary });
    } else {
      queuePreOpen(data, isBinary);
    }
  });

  browserWs.on("close", (code: number, reason: unknown) => {
    logClose("browser", code, reason);
    close();
  });
  browserWs.on("error", (err: Error) =>
    deps.log(`[mm-proxy/ws] browser error: ${err.message}`, "warn"),
  );

  return { close };
}

function frameByteLength(frame: RawData): number {
  if (typeof frame === "string") return Buffer.byteLength(frame);
  if (Buffer.isBuffer(frame)) return frame.length;
  if (Array.isArray(frame)) {
    let total = 0;
    for (const chunk of frame) total += chunk.length;
    return total;
  }
  return (frame as ArrayBuffer).byteLength;
}

export function isAuthChallengeFrame(data: RawData | string): boolean {
  const frame = parseJsonFrame(data);
  return frame?.action === "authentication_challenge";
}

export async function maybeCaptureMmTokenForAuth(
  data: RawData | string,
  resolveMmUserId: (token: string) => Promise<string | null>,
): Promise<string | null> {
  const frame = parseJsonFrame(data);
  if (!frame) return null;
  if (frame.action !== "authentication_challenge") return null;
  const token =
    frame.data && typeof frame.data === "object"
      ? (frame.data as { token?: unknown }).token
      : undefined;
  if (typeof token !== "string" || token.length === 0) return null;
  return resolveMmUserId(token);
}

export function buildAckIfUserPost(
  data: RawData | string,
  mmUserId: string | null,
  now: () => number,
): AckFrame | null {
  if (!mmUserId) return null;
  const frame = parseJsonFrame(data);
  if (!frame) return null;
  if (frame.event !== "posted") return null;
  const post = parsePostField(frame.data);
  if (!post) return null;
  if (post.user_id !== mmUserId) return null;
  return {
    event: "octogee_ack",
    data: {
      postId: post.id,
      channelId: post.channel_id,
      receivedAt: now(),
    },
  };
}

interface PartialMmFrame {
  event?: unknown;
  action?: unknown;
  data?: unknown;
}

function parseJsonFrame(data: RawData | string): PartialMmFrame | null {
  try {
    const str = rawDataToString(data);
    if (str.length === 0 || str[0] !== "{") return null;
    const parsed = JSON.parse(str) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PartialMmFrame;
    return null;
  } catch {
    return null;
  }
}

interface MmPostShape {
  id: string;
  user_id: string;
  channel_id: string;
}

function rawDataToString(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

function reasonToStr(reason: unknown): string {
  if (reason == null) return "";
  const str = Buffer.isBuffer(reason) ? reason.toString("utf-8") : String(reason);
  return str.length > 120 ? `${str.slice(0, 120)}…` : str;
}

function errorToStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return reasonToStr(err);
}

async function resolvePendingMmUserId(
  pendingMmUserId: Promise<string | null>,
  timeoutMs: number,
): Promise<string | null> {
  try {
    return await Promise.race<string | null>([
      pendingMmUserId,
      timeoutWithNull(timeoutMs),
    ]);
  } catch {
    return null;
  }
}

function timeoutWithNull(timeoutMs: number): Promise<null> {
  return new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
}

// A cancelable deadline that resolves to the ADMISSION_TIMEOUT sentinel. Raced
// against the verdict resolution; cancel() clears the timer once the race
// settles so a healthy admission leaves no dangling timer.
function makeAdmissionDeadline(timeoutMs: number): {
  promise: Promise<typeof ADMISSION_TIMEOUT>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<typeof ADMISSION_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(ADMISSION_TIMEOUT), timeoutMs);
    timer.unref?.();
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function parsePostField(eventData: unknown): MmPostShape | null {
  if (!eventData || typeof eventData !== "object") return null;
  const postField = (eventData as { post?: unknown }).post;
  let post: unknown = postField;
  if (typeof postField === "string") {
    try {
      post = JSON.parse(postField);
    } catch {
      return null;
    }
  }
  if (!post || typeof post !== "object") return null;
  const p = post as { id?: unknown; user_id?: unknown; channel_id?: unknown };
  if (typeof p.id !== "string" || typeof p.user_id !== "string" || typeof p.channel_id !== "string") {
    return null;
  }
  return { id: p.id, user_id: p.user_id, channel_id: p.channel_id };
}

function safeClose(ws: WebSocket): void {
  try {
    if (ws.readyState !== 3 ) ws.close();
  } catch {
    /* ignore */
  }
}
