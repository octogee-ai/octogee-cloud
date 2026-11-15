import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const OPENCLAW_CONTROL_SESSION_COOKIE = "__Secure-octogee-openclaw";
export const OPENCLAW_CONTROL_SESSION_IDLE_MS = 15 * 60_000;
const SESSION_IDENTITY_FIELDS = ["sid", "uid", "gid", "wid", "rid"];
function encoded(value) {
    return Buffer.from(value).toString("base64url");
}
function cookieValue(header) {
    for (const part of (header ?? "").split(";")) {
        const index = part.indexOf("=");
        if (index < 0 || part.slice(0, index).trim() !== OPENCLAW_CONTROL_SESSION_COOKIE)
            continue;
        return part.slice(index + 1).trim() || null;
    }
    return null;
}
function hasSessionIdentity(item) {
    return SESSION_IDENTITY_FIELDS.every((key) => typeof item[key] === "string" && item[key].length > 0);
}
function parsePayload(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const item = value;
    return hasSessionIdentity(item) &&
        typeof item.abs === "number" && Number.isFinite(item.abs)
        ? item
        : null;
}
export class OpenClawControlSessionManager {
    key;
    now;
    idleMs;
    sessions = new Map();
    constructor(options = {}) {
        this.key = options.key ?? randomBytes(32);
        this.now = options.now ?? Date.now;
        this.idleMs = options.idleMs ?? OPENCLAW_CONTROL_SESSION_IDLE_MS;
        if (this.key.length < 32)
            throw new Error("OpenClaw Dashboard session key must be at least 32 bytes");
        if (!Number.isSafeInteger(this.idleMs) || this.idleMs <= 0) {
            throw new Error("OpenClaw Dashboard idle lifetime must be a positive integer");
        }
    }
    issue(args) {
        const now = this.now();
        if (!Number.isFinite(args.absoluteExpiresAt) || args.absoluteExpiresAt <= now) {
            throw new Error("OpenClaw Dashboard absolute expiry must be in the future");
        }
        const stored = {
            sid: args.sessionId,
            uid: args.uid,
            gid: args.gatewayId,
            wid: args.workspaceSlug,
            rid: args.revisionId,
            abs: args.absoluteExpiresAt,
            lastActivityAt: now,
        };
        this.sessions.set(stored.sid, stored);
        const session = this.project(stored);
        return { session, cookie: this.cookieFor(stored) };
    }
    verify(args) {
        const parsed = this.verifyToken(cookieValue(args.cookieHeader));
        if (!parsed || parsed.gid !== args.gatewayId || parsed.rid !== args.revisionId)
            return null;
        return this.activeStored(parsed);
    }
    touch(args) {
        const session = this.verify(args);
        return session ? this.touchSession(session) : null;
    }
    touchSession(session) {
        const stored = this.sessions.get(session.sessionId);
        if (!stored || stored.uid !== session.uid || stored.gid !== session.gatewayId ||
            stored.wid !== session.workspaceSlug ||
            stored.rid !== session.revisionId ||
            stored.abs !== session.absoluteExpiresAt)
            return null;
        const now = this.now();
        if (stored.abs <= now || stored.lastActivityAt + this.idleMs <= now) {
            this.sessions.delete(stored.sid);
            return null;
        }
        stored.lastActivityAt = now;
        const touched = this.project(stored);
        return { session: touched, cookie: this.cookieFor(stored) };
    }
    revoke(sessionId) {
        this.sessions.delete(sessionId);
    }
    activeStored(payload) {
        const stored = this.sessions.get(payload.sid);
        if (!stored || stored.uid !== payload.uid || stored.gid !== payload.gid ||
            stored.wid !== payload.wid ||
            stored.rid !== payload.rid || stored.abs !== payload.abs)
            return null;
        const now = this.now();
        if (stored.abs <= now || stored.lastActivityAt + this.idleMs <= now) {
            this.sessions.delete(stored.sid);
            return null;
        }
        return this.project(stored);
    }
    project(stored) {
        return {
            sessionId: stored.sid,
            uid: stored.uid,
            gatewayId: stored.gid,
            workspaceSlug: stored.wid,
            revisionId: stored.rid,
            idleExpiresAt: Math.min(stored.lastActivityAt + this.idleMs, stored.abs),
            absoluteExpiresAt: stored.abs,
        };
    }
    verifyToken(token) {
        if (!token)
            return null;
        const [body, signature, extra] = token.split(".");
        if (!body || !signature || extra)
            return null;
        const expected = createHmac("sha256", this.key).update(body).digest();
        let provided;
        try {
            provided = Buffer.from(signature, "base64url");
        }
        catch {
            return null;
        }
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
            return null;
        try {
            return parsePayload(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
        }
        catch {
            return null;
        }
    }
    cookieFor(stored) {
        const body = encoded(JSON.stringify({
            sid: stored.sid,
            uid: stored.uid,
            gid: stored.gid,
            wid: stored.wid,
            rid: stored.rid,
            abs: stored.abs,
        }));
        const signature = createHmac("sha256", this.key).update(body).digest("base64url");
        const maxAge = Math.max(1, Math.floor((stored.abs - this.now()) / 1_000));
        return `${OPENCLAW_CONTROL_SESSION_COOKIE}=${body}.${signature}; Path=/g/${stored.gid}/openclaw; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
    }
}
