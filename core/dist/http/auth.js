import { withLogContext } from "@octogee/shared/server/service-logger";
import * as crypto from "crypto";
import { isUserCredentialRejected, } from "../user-identity-provider.js";
import { resolveCanonicalWorkspaceSlug } from "../workspace/canonical-workspace.js";
import { platformStateStore } from "../identity/platform-state-store.js";
import { logger } from "./logging.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
let installedProvider = null;
export function installUserIdentityProvider(provider) {
    installedProvider = provider;
}
export async function loadUserWithInstalledProvider(uid) {
    if (installedProvider === null)
        throw new Error("no user identity provider is installed");
    return installedProvider.loadUser(uid);
}
function userIdentityProvider(res) {
    if (installedProvider === null) {
        logger.error("User authentication is unavailable: no user identity provider is installed");
        res.status(503).json({ error: "Authentication unavailable" });
    }
    return installedProvider;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function authenticateUid(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthenticated" });
        return;
    }
    const provider = userIdentityProvider(res);
    if (provider === null)
        return;
    const token = header.slice(7);
    void (async () => {
        let verified;
        try {
            verified = await provider.verifyBearer(token);
        }
        catch (err) {
            if (isUserCredentialRejected(err)) {
                logger.warn(`Auth failed: ${err.message}`);
                res.status(401).json({ error: "Invalid token" });
                return;
            }
            logger.error(`User authentication is unavailable: ${errorMessage(err)}`);
            res.status(503).json({ error: "Authentication lookup unavailable" });
            return;
        }
        req.uid = verified.uid;
        req.authTime = verified.authTime ?? undefined;
        next();
    })();
}
export const RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60;
export function requireRecentAuthentication(req, res, next) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const authTime = req.authTime;
    if (typeof authTime !== "number" ||
        authTime > nowSeconds + 60 ||
        nowSeconds - authTime > RECENT_AUTH_MAX_AGE_SECONDS) {
        res.status(403).json({
            error: "auth/requires-recent-login",
            message: "Recent authentication required",
        });
        return;
    }
    next();
}
export function requireAuthenticatedUid(req, res, next) {
    authenticateUid(req, res, next);
}
function attachActiveUser(req, res, next, allowUnregistered) {
    const provider = userIdentityProvider(res);
    if (provider === null)
        return;
    void (async () => {
        const userData = await provider.loadUser(req.uid);
        if (userData === null) {
            if (allowUnregistered) {
                req.user = undefined;
                next();
                return;
            }
            res.status(403).json({ error: "Account is not active" });
            return;
        }
        if (!accountAllowsInteractiveAccess(userData)) {
            res.status(403).json({ error: "Account is not active" });
            return;
        }
        req.user = userData;
        next();
    })().catch((err) => {
        logger.warn(`Auth lookup failed: ${errorMessage(err)}`);
        res.status(503).json({ error: "Authentication lookup unavailable" });
    });
}
function attachAuthContext(req, res, next) {
    const uid = req.uid;
    void (async () => {
        req.workspaceSlug = await resolveCanonicalWorkspaceSlug(uid, req.user);
        try {
            req.isAdmin = (await platformStateStore.users.records.getRole(uid)) === "admin";
        }
        catch (err) {
            logger.warn(`Admin role lookup failed: ${err.message}`);
            req.isAdmin = false;
        }
        withLogContext(req.workspaceSlug ? { builderSlug: req.workspaceSlug } : {}, next);
    })().catch((err) => {
        logger.warn(`Auth lookup failed: ${err.message}`);
        res.status(503).json({ error: "Authentication lookup unavailable" });
    });
}
export function requireActiveAccount(req, res, next) {
    if (!req.uid) {
        res.status(401).json({ error: "Unauthenticated" });
        return;
    }
    attachActiveUser(req, res, () => attachAuthContext(req, res, next), false);
}
export function requireAuth(req, res, next) {
    requireAuthenticatedUid(req, res, () => {
        attachActiveUser(req, res, () => attachAuthContext(req, res, next), false);
    });
}
export function requireAuthAllowUnregistered(req, res, next) {
    requireAuthenticatedUid(req, res, () => {
        attachActiveUser(req, res, () => attachAuthContext(req, res, next), true);
    });
}
export function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.isAdmin) {
            res.status(403).json({ error: "Admin access required" });
            return;
        }
        next();
    });
}
function boundTenantKind(req) {
    return req.boundTenant?.kind;
}
export function requireInternalServiceAuth(req, res, next) {
    if (boundTenantKind(req) === "gateway") {
        next();
        return;
    }
    res.status(401).json({ error: "internal auth required" });
}
export function requireInternalPlatformAuth(req, res, next) {
    const kind = boundTenantKind(req);
    if (kind === "gateway" || kind === "platform") {
        next();
        return;
    }
    res.status(401).json({ error: "internal auth required" });
}
function timingSafeStringEqual(a, b) {
    try {
        return (a.length === b.length &&
            crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
    }
    catch {
        return false;
    }
}
function bearerFromRequest(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer "))
        return null;
    const token = header.slice("Bearer ".length).trim();
    return token || null;
}
export function requireSocialNotificationAuth(req, res, next) {
    const configured = process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN;
    const provided = bearerFromRequest(req);
    if (configured && provided && timingSafeStringEqual(provided, configured)) {
        next();
        return;
    }
    res.status(401).json({ error: "invalid social notification bearer" });
}
