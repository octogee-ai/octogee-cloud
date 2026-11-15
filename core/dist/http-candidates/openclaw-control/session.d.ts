export declare const OPENCLAW_CONTROL_SESSION_COOKIE = "__Secure-octogee-openclaw";
export declare const OPENCLAW_CONTROL_SESSION_IDLE_MS: number;
export interface OpenClawControlSession {
    sessionId: string;
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    revisionId: string;
    idleExpiresAt: number;
    absoluteExpiresAt: number;
}
export declare class OpenClawControlSessionManager {
    private readonly key;
    private readonly now;
    private readonly idleMs;
    private readonly sessions;
    constructor(options?: {
        key?: Buffer;
        now?: () => number;
        idleMs?: number;
    });
    issue(args: {
        sessionId: string;
        uid: string;
        gatewayId: string;
        workspaceSlug: string;
        revisionId: string;
        absoluteExpiresAt: number;
    }): {
        session: OpenClawControlSession;
        cookie: string;
    };
    verify(args: {
        cookieHeader?: string;
        gatewayId: string;
        revisionId: string;
    }): OpenClawControlSession | null;
    touch(args: {
        cookieHeader?: string;
        gatewayId: string;
        revisionId: string;
    }): {
        session: OpenClawControlSession;
        cookie: string;
    } | null;
    touchSession(session: OpenClawControlSession): {
        session: OpenClawControlSession;
        cookie: string;
    } | null;
    revoke(sessionId: string): void;
    private activeStored;
    private project;
    private verifyToken;
    private cookieFor;
}
