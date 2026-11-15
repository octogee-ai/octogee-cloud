import { internalFetch } from "../../internal-fetch.js";
export const OPENCLAW_CONTROL_BROKER_TIMEOUT_MS = 5_000;
export const OPENCLAW_CONTROL_AUTHORIZATION_CACHE_TTL_MS = 10_000;
const MAX_AUTHORIZATION_CACHE_PRUNE_PER_CALL = 64;
export class OpenClawControlBrokerError extends Error {
    kind;
    constructor(kind, message, options) {
        super(message, options);
        this.kind = kind;
        this.name = "OpenClawControlBrokerError";
    }
}
export function openClawControlBrokerFailureKind(error) {
    return error instanceof OpenClawControlBrokerError ? error.kind : null;
}
function baseUrl(env) {
    const value = env.OPENCLAW_CONTROL_BROKER_URL ?? env.OCTOGEE_API_URL;
    if (!value?.trim())
        throw new Error("OPENCLAW_CONTROL_BROKER_URL or OCTOGEE_API_URL is required");
    return value.trim().replace(/\/$/u, "");
}
export async function postOpenClawControlBroker(path, body, env, fetchImpl, signal) {
    const url = `${baseUrl(env)}${path}`;
    const timeout = AbortSignal.timeout(OPENCLAW_CONTROL_BROKER_TIMEOUT_MS);
    try {
        return await internalFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        }, { fetchImpl });
    }
    catch (error) {
        throw new OpenClawControlBrokerError(timeout.aborted ? "timeout" : "unavailable", timeout.aborted
            ? "OpenClaw Control broker request timed out"
            : "OpenClaw Control broker request failed", { cause: error });
    }
}
function boundedIdentifier(value, maxLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}
function validRedemptionIdentity(item) {
    return boundedIdentifier(item.uid, 256) &&
        boundedIdentifier(item.gatewayId, 128) &&
        boundedIdentifier(item.workspaceSlug, 128) &&
        boundedIdentifier(item.revisionId, 128);
}
function validRedemptionResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const item = value;
    return validRedemptionIdentity(item) &&
        typeof item.expiresAt === "number" &&
        Number.isFinite(item.expiresAt) &&
        item.expiresAt > 0;
}
export async function redeemOpenClawControlTicket(args) {
    const res = await postOpenClawControlBroker("/internal/openclaw-control/redeem", {
        gatewayId: args.gatewayId,
        revisionId: args.revisionId,
        sessionId: args.sessionId,
        ticket: args.ticket,
    }, args.env ?? process.env, args.fetchImpl);
    if (res.status === 404)
        return null;
    if (!res.ok) {
        throw new OpenClawControlBrokerError("unavailable", `OpenClaw Control ticket broker returned ${res.status}`);
    }
    let body;
    try {
        body = await res.json();
    }
    catch (error) {
        throw new OpenClawControlBrokerError("unavailable", "OpenClaw Control ticket broker returned invalid JSON", { cause: error });
    }
    if (!validRedemptionResponse(body)) {
        throw new OpenClawControlBrokerError("unavailable", "OpenClaw Control ticket broker returned invalid JSON");
    }
    return {
        uid: body.uid,
        gatewayId: body.gatewayId,
        workspaceSlug: body.workspaceSlug,
        revisionId: body.revisionId,
        expiresAt: body.expiresAt,
    };
}
export async function authorizeOpenClawControlSession(args) {
    const res = await postOpenClawControlBroker("/internal/openclaw-control/authorize", {
        gatewayId: args.gatewayId,
        revisionId: args.revisionId,
        sessionId: args.sessionId,
    }, args.env ?? process.env, args.fetchImpl);
    if (res.status === 403 || res.status === 404)
        return false;
    if (res.status !== 204) {
        throw new OpenClawControlBrokerError("unavailable", `OpenClaw Control authorization broker returned ${res.status}`);
    }
    return true;
}
function authorizationCacheKey(args) {
    return JSON.stringify([args.gatewayId, args.revisionId, args.sessionId]);
}
export class OpenClawControlAuthorizationCache {
    authorized = new Map();
    inFlight = new Map();
    ttlMs;
    now;
    authorizeBroker;
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? OPENCLAW_CONTROL_AUTHORIZATION_CACHE_TTL_MS;
        if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
            throw new Error("OpenClaw Dashboard authorization cache TTL must be a positive integer");
        }
        this.now = options.now ?? Date.now;
        this.authorizeBroker = options.authorize ?? authorizeOpenClawControlSession;
    }
    async authorize(args, options = {}) {
        this.pruneExpired();
        const key = authorizationCacheKey(args);
        if (options.forceRefresh)
            return this.authorizeFresh(key, args);
        const expiresAt = this.authorized.get(key);
        if (expiresAt !== undefined) {
            if (expiresAt > this.now())
                return true;
            this.authorized.delete(key);
        }
        const existing = this.inFlight.get(key);
        if (existing)
            return existing;
        const pending = this.authorizeFresh(key, args);
        this.inFlight.set(key, pending);
        pending.then(() => {
            if (this.inFlight.get(key) === pending)
                this.inFlight.delete(key);
        }, () => {
            if (this.inFlight.get(key) === pending)
                this.inFlight.delete(key);
        });
        return pending;
    }
    async authorizeFresh(key, args) {
        try {
            const allowed = await this.authorizeBroker(args);
            if (allowed)
                this.authorized.set(key, this.now() + this.ttlMs);
            else
                this.authorized.delete(key);
            return allowed;
        }
        catch (error) {
            this.authorized.delete(key);
            throw error;
        }
    }
    pruneExpired() {
        const now = this.now();
        let inspected = 0;
        for (const [key, expiresAt] of this.authorized) {
            if (expiresAt <= now)
                this.authorized.delete(key);
            inspected += 1;
            if (inspected >= MAX_AUTHORIZATION_CACHE_PRUNE_PER_CALL)
                return;
        }
    }
}
export function createOpenClawControlAuthorizationCache(options = {}) {
    return new OpenClawControlAuthorizationCache(options);
}
