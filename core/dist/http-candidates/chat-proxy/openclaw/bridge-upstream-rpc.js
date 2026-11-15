import { randomUUID } from "node:crypto";
import { isResponseFrame } from "@octogee/shared/types/openclaw-wire-core";
export function attachUpstreamRpcClient(ws, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const inFlight = new Map();
    let disposed = false;
    const onMessage = (data) => {
        let raw;
        if (typeof data === "string") {
            raw = data;
        }
        else if (data && typeof data.toString === "function") {
            raw = data.toString();
        }
        else {
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return;
        }
        // Match the canonical wire protocol (packages/gateway-protocol RequestFrame/
        // ResponseFrameSchema, mirrored in shared/types/openclaw-wire-core): responses
        // are { type:"res", id, ok, payload?, error? }. The old hand-rolled match on
        // type:"response" + .result never matched this gateway, so every RPC timed out.
        if (!isResponseFrame(parsed))
            return;
        const env = parsed;
        const pending = inFlight.get(env.id);
        if (!pending)
            return;
        inFlight.delete(env.id);
        clearTimeout(pending.timer);
        if (env.ok === true) {
            pending.resolve({ ok: true, result: env.payload });
        }
        else {
            const errMsg = typeof env.error?.message === "string" ? env.error.message : "rpc error";
            const error = typeof env.error?.code === "string" && typeof env.error.message === "string" ? { code: env.error.code, message: env.error.message, ...(env.error.details !== undefined ? { details: env.error.details } : {}) } : undefined;
            pending.resolve({ ok: false, reason: errMsg, ...(error ? { error } : {}) });
        }
    };
    const onClose = () => {
        for (const [id, pending] of inFlight.entries()) {
            clearTimeout(pending.timer);
            pending.resolve({ ok: false, reason: "upstream-ws-closed" });
            inFlight.delete(id);
        }
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    const call = async (method, params) => {
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
                resolve: resolve,
                timer,
            });
            try {
                ws.send(JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params,
                }));
            }
            catch (err) {
                inFlight.delete(id);
                clearTimeout(timer);
                resolve({
                    ok: false,
                    reason: `rpc-send-failed: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        });
    };
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        for (const [id, pending] of inFlight.entries()) {
            clearTimeout(pending.timer);
            pending.resolve({ ok: false, reason: "client-disposed" });
            inFlight.delete(id);
        }
        try {
            ws.off("message", onMessage);
            ws.off("close", onClose);
        }
        catch {
            /* */
        }
    };
    return { call, dispose };
}
