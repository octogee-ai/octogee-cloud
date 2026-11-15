import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { OpenclawWireError, startConnectChallengeTracker, waitForWsOpen, sendWsRequest, } from "@octogee/shared/types/openclaw-wire-core";
import { signConnectDevice, } from "@octogee/shared/types/device-identity";
import { OPENCLAW_CONTROL_UI_CLIENT_ID, } from "@octogee/shared/types/openclaw-proxy-identity";
export { OpenclawWireError, };
const PROTOCOL_VERSION = OPENCLAW_PROTOCOL_VERSION;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const SETUP_CODE_RESPONSE_PREFIX = "device.pair.setupCode returned";
const DEFAULT_OPERATOR_SCOPES = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.pairing",
];
function authForParams(params) {
    if (params.deviceToken)
        return { deviceToken: params.deviceToken };
    if (params.bootstrapToken)
        return { bootstrapToken: params.bootstrapToken };
    if (params.token)
        return { token: params.token };
    return undefined;
}
function tokenForDeviceSignature(params) {
    return params.deviceToken || params.bootstrapToken || params.token || null;
}
function loopbackPairingUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new OpenclawWireError("connect-failed", "OpenClaw pairing URL is invalid");
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    const loopback = hostname === "localhost" ||
        hostname === "::1" ||
        hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/u.test(hostname);
    if (!loopback || parsed.username || parsed.password) {
        throw new OpenclawWireError("connect-failed", "native OpenClaw device bootstrap requires a credential-free loopback URL");
    }
    if (parsed.protocol === "http:")
        parsed.protocol = "ws:";
    else if (parsed.protocol === "https:")
        parsed.protocol = "wss:";
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new OpenclawWireError("connect-failed", "native OpenClaw device bootstrap requires an HTTP or WebSocket URL");
    }
    parsed.search = "";
    parsed.hash = "";
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
}
function setupCodeResponseError(detail) {
    return new OpenclawWireError("invalid-response", `${SETUP_CODE_RESPONSE_PREFIX} ${detail}`);
}
function assertValidOptionalExpiry(value, invalidDetail) {
    if (value !== undefined &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value <= Date.now())) {
        throw setupCodeResponseError(invalidDetail);
    }
}
function decodeSetupCode(value) {
    if (typeof value !== "string" ||
        !value ||
        value.length > 65_536 ||
        !/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw setupCodeResponseError("an invalid code");
    }
    try {
        return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    }
    catch {
        throw setupCodeResponseError("an invalid code");
    }
}
function requireBootstrapToken(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) {
        throw setupCodeResponseError("no bootstrap credential");
    }
    return value.trim();
}
function setupBootstrapToken(payload, expectedUrl) {
    if (!payload || typeof payload !== "object") {
        throw setupCodeResponseError("no payload");
    }
    const result = payload;
    if (result.access !== "full") {
        throw new OpenclawWireError("invalid-response", "device.pair.setupCode did not grant the required full local access profile");
    }
    assertValidOptionalExpiry(result.expiresAtMs, "an expired setup");
    const decoded = decodeSetupCode(result.setupCode);
    if (!decoded || typeof decoded !== "object") {
        throw setupCodeResponseError("an invalid payload");
    }
    const setup = decoded;
    if (setup.url !== expectedUrl) {
        throw new OpenclawWireError("invalid-response", "device.pair.setupCode returned a different gateway URL");
    }
    assertValidOptionalExpiry(setup.expiresAtMs, "an expired code");
    if (typeof result.expiresAtMs === "number" &&
        typeof setup.expiresAtMs === "number" &&
        result.expiresAtMs !== setup.expiresAtMs) {
        throw new OpenclawWireError("invalid-response", "device.pair.setupCode returned conflicting expiry metadata");
    }
    return requireBootstrapToken(setup.bootstrapToken);
}
export async function requestDevicePairBootstrapToken(params) {
    const publicUrl = loopbackPairingUrl(params.url);
    const payload = await sendWsRequest({
        ws: params.ws,
        id: randomUUID(),
        method: "device.pair.setupCode",
        params: { publicUrl, includeQr: false },
        timeoutMs: params.timeoutMs,
    });
    return setupBootstrapToken(payload, publicUrl);
}
function helloAuthInfo(helloOk) {
    return helloOk && typeof helloOk === "object"
        ? helloOk.auth
        : undefined;
}
async function emitDeviceToken(params, helloOk) {
    const authInfo = helloAuthInfo(helloOk);
    if (typeof authInfo?.deviceToken !== "string" || !authInfo.deviceToken.trim())
        return;
    await params.onDeviceToken?.({
        deviceToken: authInfo.deviceToken,
        role: typeof authInfo.role === "string" ? authInfo.role : undefined,
        scopes: Array.isArray(authInfo.scopes)
            ? authInfo.scopes.filter((scope) => typeof scope === "string")
            : undefined,
    });
}
function proxyIdentityConnectParams() {
    return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
            id: OPENCLAW_CONTROL_UI_CLIENT_ID,
            displayName: "octogee-chat-proxy",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
        },
        role: "operator",
    };
}
function deviceConnectParams(params, nonce, scopes) {
    const clientInfo = {
        id: "gateway-client",
        displayName: "octogee-chat-proxy",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
    };
    const device = signConnectDevice({
        identity: params.identity,
        clientId: clientInfo.id,
        clientMode: clientInfo.mode,
        role: "operator",
        scopes,
        nonce,
        token: tokenForDeviceSignature(params),
        platform: clientInfo.platform,
    });
    const auth = authForParams(params);
    return {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes,
        device,
        ...(auth ? { auth } : {}),
    };
}
export async function openUpstream(params) {
    const scopes = params.scopes ?? [...DEFAULT_OPERATOR_SCOPES];
    const timeoutMs = params.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const wsUrl = params.url.replace(/^http/, "ws");
    const ws = params.proxyIdentity
        ? new WebSocket(wsUrl, { headers: params.proxyIdentity.headers })
        : new WebSocket(wsUrl);
    ws.on("error", () => { });
    const nonceTracker = startConnectChallengeTracker(ws);
    try {
        await waitForWsOpen(ws, timeoutMs);
        const nonce = await nonceTracker.wait(timeoutMs);
        const helloOk = await sendWsRequest({
            ws,
            id: randomUUID(),
            method: "connect",
            params: params.proxyIdentity
                ? proxyIdentityConnectParams()
                : deviceConnectParams(params, nonce, scopes),
            timeoutMs,
            mapConnectErrors: true,
        });
        await emitDeviceToken(params, helloOk);
        return ws;
    }
    catch (err) {
        try {
            ws.terminate();
        }
        catch {
            /* */
        }
        throw err;
    }
}
