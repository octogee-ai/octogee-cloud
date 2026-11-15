import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { CONTROL_UI_COMMAND_PATH } from "../mattermost/control-ui-command.js";
const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const PROOF_WINDOW_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
export function validAgentControlRouterPublicKey(key) {
    try {
        return createPublicKey(key).asymmetricKeyType === "ed25519" && key.includes("BEGIN PUBLIC KEY");
    }
    catch {
        return false;
    }
}
function routerSigningKey(key) {
    try {
        const parsed = createPrivateKey(key);
        if (parsed.asymmetricKeyType === "ed25519")
            return parsed;
    }
    catch {
        throw new Error("AGENT_CONTROL_ROUTER_KEY must be an Ed25519 private key");
    }
    throw new Error("AGENT_CONTROL_ROUTER_KEY must be an Ed25519 private key");
}
function bodySha256(body) {
    return createHash("sha256").update(body).digest("hex");
}
function proofPayload(body, gatewayId, timestamp) {
    return `v1\n${gatewayId}\n${timestamp}\n${bodySha256(body)}`;
}
function commandProofPayload(body, command, timestamp) {
    return `v1-mattermost-command\n${command}\n${timestamp}\n${bodySha256(body)}`;
}
export function signAgentControlRouterRequest(body, gatewayId, timestamp, key) {
    return sign(null, Buffer.from(proofPayload(body, gatewayId, timestamp)), routerSigningKey(key)).toString("hex");
}
export const CONTROL_UI_COMMAND = "control-ui";
export function signMattermostCommandRequest(body, command, timestamp, key) {
    return sign(null, Buffer.from(commandProofPayload(body, command, timestamp)), routerSigningKey(key)).toString("hex");
}
function freshTimestamp(timestamp, now) {
    if (!/^\d+$/.test(timestamp))
        return false;
    const value = Number(timestamp);
    return Number.isSafeInteger(value) && Math.abs(now - value) <= PROOF_WINDOW_MS;
}
export function verifyMattermostCommandRequest(body, proof, key, now) {
    if (!validAgentControlRouterPublicKey(key))
        return false;
    if (proof.command !== CONTROL_UI_COMMAND || !freshTimestamp(proof.timestamp, now))
        return false;
    if (!/^[a-f0-9]{128}$/i.test(proof.signature))
        return false;
    return verify(null, Buffer.from(commandProofPayload(body, proof.command, proof.timestamp)), key, Buffer.from(proof.signature, "hex"));
}
export function verifyAgentControlRouterRequest(body, proof, key, now) {
    if (!validAgentControlRouterPublicKey(key))
        return false;
    if (!isValidGatewayId(proof.gatewayId) || !/^\d+$/.test(proof.timestamp))
        return false;
    const timestamp = Number(proof.timestamp);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > PROOF_WINDOW_MS)
        return false;
    if (!/^[a-f0-9]{128}$/i.test(proof.signature))
        return false;
    return verify(null, Buffer.from(proofPayload(body, proof.gatewayId, proof.timestamp)), key, Buffer.from(proof.signature, "hex"));
}
function parseRoute(url) {
    if (!url.startsWith("/"))
        return null;
    const queryStart = url.indexOf("?");
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    if (path === CONTROL_UI_COMMAND_PATH)
        return { kind: "command", command: CONTROL_UI_COMMAND };
    const interaction = /^\/internal\/openclaw\/mattermost\/([^/]+)\/mattermost\/interactions\/([^/]+)$/.exec(path);
    if (interaction &&
        isValidGatewayId(interaction[1]) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(interaction[2])) {
        return {
            kind: "interaction",
            gatewayId: interaction[1],
            accountId: interaction[2],
        };
    }
    return null;
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const timeout = setTimeout(() => {
            req.destroy();
            reject(new Error("body_read_timeout"));
        }, BODY_TIMEOUT_MS);
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                clearTimeout(timeout);
                req.destroy();
                reject(new Error("body_too_large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            clearTimeout(timeout);
            resolve(Buffer.concat(chunks));
        });
        req.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}
const HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);
function forwardedHeaders(incoming, body, proofHeaders) {
    const headers = {};
    const connectionHeaders = new Set((typeof incoming.connection === "string" ? incoming.connection : "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
    for (const [name, value] of Object.entries(incoming)) {
        const lower = name.toLowerCase();
        if (lower === "host" ||
            lower === "content-length" ||
            HOP_HEADERS.has(lower) ||
            connectionHeaders.has(lower) ||
            lower.startsWith("x-octogee-"))
            continue;
        headers[name] = value;
    }
    headers["content-length"] = String(body.length);
    return { ...headers, ...proofHeaders };
}
function responseHeaders(incoming, bodyLength) {
    const headers = {};
    const connectionHeaders = new Set((typeof incoming.connection === "string" ? incoming.connection : "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
    for (const [name, value] of Object.entries(incoming)) {
        const lower = name.toLowerCase();
        if (lower === "content-length" ||
            HOP_HEADERS.has(lower) ||
            connectionHeaders.has(lower))
            continue;
        headers[name] = value;
    }
    headers["content-length"] = String(bodyLength);
    return headers;
}
function readUpstreamBody(upstream, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        upstream.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                upstream.destroy(new Error("upstream_response_too_large"));
                reject(new Error("upstream_response_too_large"));
                return;
            }
            chunks.push(chunk);
        });
        upstream.on("end", () => resolve(Buffer.concat(chunks)));
        upstream.on("error", reject);
    });
}
function interactionDelivery(route, body, timestamp, input) {
    return {
        origin: new URL(input.origin),
        path: `/api/g/${route.gatewayId}/internal/openclaw/mattermost/interactions/${route.accountId}`,
        proofHeaders: {
            "x-octogee-agent-control-gateway": route.gatewayId,
            "x-octogee-agent-control-timestamp": timestamp,
            "x-octogee-agent-control-signature": signAgentControlRouterRequest(body, route.gatewayId, timestamp, input.signingKey),
        },
        logMeta: { gatewayId: route.gatewayId },
    };
}
function commandDelivery(route, body, timestamp, input) {
    return {
        origin: new URL(input.origin),
        path: CONTROL_UI_COMMAND_PATH,
        proofHeaders: {
            "x-octogee-mattermost-command": route.command,
            "x-octogee-mattermost-command-timestamp": timestamp,
            "x-octogee-mattermost-command-signature": signMattermostCommandRequest(body, route.command, timestamp, input.signingKey),
        },
        logMeta: { command: route.command },
    };
}
function writeJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}
export function createAgentControlCallbackRouter(input) {
    routerSigningKey(input.signingKey);
    const now = input.now ?? Date.now;
    const targetOrigin = input.targetOrigin ?? ((gatewayId) => `http://gateway-edge-${gatewayId}.${input.namespace}.svc.cluster.local:3001`);
    const apiOrigin = input.apiOrigin ?? `http://octogee-api.${input.namespace}.svc.cluster.local:3001`;
    const upstreamTimeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
    const maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) {
        throw new Error("invalid agent control upstreamTimeoutMs");
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
        throw new Error("invalid agent control maxResponseBytes");
    }
    return http.createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            writeJson(res, 200, { status: "ok" });
            return;
        }
        if (req.method !== "POST") {
            req.resume();
            writeJson(res, req.method === "GET" ? 404 : 405, { error: "not_found" });
            return;
        }
        const route = parseRoute(req.url ?? "");
        if (!route) {
            req.resume();
            writeJson(res, 404, { error: "not_found" });
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "body_too_large")
                writeJson(res, 413, { error: "body_too_large" });
            else if (message === "body_read_timeout")
                writeJson(res, 400, { error: "body_read_timeout" });
            else {
                input.log("agent control callback body read failed", { error: message });
                writeJson(res, 400, { error: "invalid_body" });
            }
            return;
        }
        const timestamp = String(now());
        const delivery = route.kind === "command"
            ? commandDelivery(route, body, timestamp, { signingKey: input.signingKey, origin: apiOrigin })
            : interactionDelivery(route, body, timestamp, {
                signingKey: input.signingKey,
                origin: input.resolveVmOrigin?.(route.gatewayId) ?? targetOrigin(route.gatewayId),
            });
        let responded = false;
        const fail = (error) => {
            input.log("[agent-control-router] upstream request failed", {
                ...delivery.logMeta,
                error: error.message,
            });
            if (responded)
                return;
            responded = true;
            writeJson(res, 502, { error: "gateway_unavailable" });
        };
        const proxy = http.request({
            protocol: delivery.origin.protocol,
            hostname: delivery.origin.hostname,
            port: delivery.origin.port,
            method: "POST",
            path: delivery.path,
            headers: forwardedHeaders(req.headers, body, delivery.proofHeaders),
        }, async (upstream) => {
            try {
                const upstreamBody = await readUpstreamBody(upstream, maxResponseBytes);
                if (responded)
                    return;
                responded = true;
                res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers, upstreamBody.length));
                res.end(upstreamBody);
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        });
        proxy.setTimeout(upstreamTimeoutMs, () => proxy.destroy(new Error("upstream_timeout")));
        proxy.on("error", fail);
        proxy.end(body);
    });
}
