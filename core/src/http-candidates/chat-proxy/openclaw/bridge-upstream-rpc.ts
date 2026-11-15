import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { isResponseFrame } from "@octogee/shared/types/openclaw-wire-core";

export interface UpstreamRpcError { code: string; message: string; details?: unknown }
export interface UpstreamRpcFailure { ok: false; reason: string; error?: UpstreamRpcError }

export interface UpstreamRpcClient {
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: T } | UpstreamRpcFailure>;
  dispose(): void;
}

export interface AttachUpstreamRpcOptions {
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (v: { ok: true; result: unknown } | UpstreamRpcFailure) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function attachUpstreamRpcClient(
  ws: WebSocket,
  opts: AttachUpstreamRpcOptions = {},
): UpstreamRpcClient {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const inFlight = new Map<string, PendingCall>();
  let disposed = false;

  const onMessage = (data: unknown): void => {
    let raw: string;
    if (typeof data === "string") {
      raw = data;
    } else if (data && typeof (data as { toString?: () => string }).toString === "function") {
      raw = (data as { toString: () => string }).toString();
    } else {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // Match the canonical wire protocol (packages/gateway-protocol RequestFrame/
    // ResponseFrameSchema, mirrored in shared/types/openclaw-wire-core): responses
    // are { type:"res", id, ok, payload?, error? }. The old hand-rolled match on
    // type:"response" + .result never matched this gateway, so every RPC timed out.
    if (!isResponseFrame(parsed)) return;
    const env = parsed;
    const pending = inFlight.get(env.id);
    if (!pending) return;
    inFlight.delete(env.id);
    clearTimeout(pending.timer);
    if (env.ok === true) {
      pending.resolve({ ok: true, result: env.payload });
    } else {
      const errMsg =
        typeof env.error?.message === "string" ? env.error.message : "rpc error";
      const error = typeof env.error?.code === "string" && typeof env.error.message === "string" ? { code: env.error.code, message: env.error.message, ...(env.error.details !== undefined ? { details: env.error.details } : {}) } : undefined;
      pending.resolve({ ok: false, reason: errMsg, ...(error ? { error } : {}) });
    }
  };

  const onClose = (): void => {
    for (const [id, pending] of inFlight.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: "upstream-ws-closed" });
      inFlight.delete(id);
    }
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);

  const call = async <T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: T } | UpstreamRpcFailure> => {
    if (disposed) {
      return { ok: false, reason: "client-disposed" };
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (inFlight.has(id)) {
          inFlight.delete(id);
          resolve({ ok: false, reason: `rpc-timeout after ${timeoutMs}ms (${method})` });
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      inFlight.set(id, {
        resolve: resolve as PendingCall["resolve"],
        timer,
      });
      try {
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method,
            params,
          }),
        );
      } catch (err) {
        inFlight.delete(id);
        clearTimeout(timer);
        resolve({
          ok: false,
          reason: `rpc-send-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const [id, pending] of inFlight.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: "client-disposed" });
      inFlight.delete(id);
    }
    try {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    } catch {
      /* */
    }
  };

  return { call, dispose };
}
