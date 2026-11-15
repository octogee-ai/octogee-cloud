import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OPENCLAW_CONTROL_SESSION_COOKIE = "__Secure-octogee-openclaw";
export const OPENCLAW_CONTROL_SESSION_IDLE_MS = 15 * 60_000;

export interface OpenClawControlSession {
  sessionId: string;
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  revisionId: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

interface SessionPayload {
  sid: string;
  uid: string;
  gid: string;
  wid: string;
  rid: string;
  abs: number;
}

interface StoredSession extends SessionPayload {
  lastActivityAt: number;
}

const SESSION_IDENTITY_FIELDS = ["sid", "uid", "gid", "wid", "rid"] as const;

function encoded(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function cookieValue(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== OPENCLAW_CONTROL_SESSION_COOKIE) continue;
    return part.slice(index + 1).trim() || null;
  }
  return null;
}

function hasSessionIdentity(item: Record<string, unknown>): boolean {
  return SESSION_IDENTITY_FIELDS.every((key) =>
    typeof item[key] === "string" && item[key].length > 0
  );
}

function parsePayload(value: unknown): SessionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  return hasSessionIdentity(item) &&
    typeof item.abs === "number" && Number.isFinite(item.abs)
    ? item as unknown as SessionPayload
    : null;
}

export class OpenClawControlSessionManager {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(options: {
    key?: Buffer;
    now?: () => number;
    idleMs?: number;
  } = {}) {
    this.key = options.key ?? randomBytes(32);
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? OPENCLAW_CONTROL_SESSION_IDLE_MS;
    if (this.key.length < 32) throw new Error("OpenClaw Dashboard session key must be at least 32 bytes");
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs <= 0) {
      throw new Error("OpenClaw Dashboard idle lifetime must be a positive integer");
    }
  }

  issue(args: {
    sessionId: string;
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    revisionId: string;
    absoluteExpiresAt: number;
  }): { session: OpenClawControlSession; cookie: string } {
    const now = this.now();
    if (!Number.isFinite(args.absoluteExpiresAt) || args.absoluteExpiresAt <= now) {
      throw new Error("OpenClaw Dashboard absolute expiry must be in the future");
    }
    const stored: StoredSession = {
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

  verify(args: {
    cookieHeader?: string;
    gatewayId: string;
    revisionId: string;
  }): OpenClawControlSession | null {
    const parsed = this.verifyToken(cookieValue(args.cookieHeader));
    if (!parsed || parsed.gid !== args.gatewayId || parsed.rid !== args.revisionId) return null;
    return this.activeStored(parsed);
  }

  touch(args: {
    cookieHeader?: string;
    gatewayId: string;
    revisionId: string;
  }): { session: OpenClawControlSession; cookie: string } | null {
    const session = this.verify(args);
    return session ? this.touchSession(session) : null;
  }

  touchSession(session: OpenClawControlSession): {
    session: OpenClawControlSession;
    cookie: string;
  } | null {
    const stored = this.sessions.get(session.sessionId);
    if (!stored || stored.uid !== session.uid || stored.gid !== session.gatewayId ||
      stored.wid !== session.workspaceSlug ||
      stored.rid !== session.revisionId ||
      stored.abs !== session.absoluteExpiresAt) return null;
    const now = this.now();
    if (stored.abs <= now || stored.lastActivityAt + this.idleMs <= now) {
      this.sessions.delete(stored.sid);
      return null;
    }
    stored.lastActivityAt = now;
    const touched = this.project(stored);
    return { session: touched, cookie: this.cookieFor(stored) };
  }

  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private activeStored(payload: SessionPayload): OpenClawControlSession | null {
    const stored = this.sessions.get(payload.sid);
    if (!stored || stored.uid !== payload.uid || stored.gid !== payload.gid ||
      stored.wid !== payload.wid ||
      stored.rid !== payload.rid || stored.abs !== payload.abs) return null;
    const now = this.now();
    if (stored.abs <= now || stored.lastActivityAt + this.idleMs <= now) {
      this.sessions.delete(stored.sid);
      return null;
    }
    return this.project(stored);
  }

  private project(stored: StoredSession): OpenClawControlSession {
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

  private verifyToken(token: string | null): SessionPayload | null {
    if (!token) return null;
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const expected = createHmac("sha256", this.key).update(body).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "base64url");
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    try {
      return parsePayload(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    } catch {
      return null;
    }
  }

  private cookieFor(stored: StoredSession): string {
    const body = encoded(JSON.stringify({
      sid: stored.sid,
      uid: stored.uid,
      gid: stored.gid,
      wid: stored.wid,
      rid: stored.rid,
      abs: stored.abs,
    } satisfies SessionPayload));
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    const maxAge = Math.max(1, Math.floor((stored.abs - this.now()) / 1_000));
    return `${OPENCLAW_CONTROL_SESSION_COOKIE}=${body}.${signature}; Path=/g/${stored.gid}/openclaw; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
  }
}
