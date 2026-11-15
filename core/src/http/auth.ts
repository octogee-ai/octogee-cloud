import { withLogContext } from "@octogee/shared/server/service-logger";
import * as crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import {
  isUserCredentialRejected,
  type UserDocument,
  type UserIdentityProvider,
  type VerifiedUser,
} from "../user-identity-provider.js";
import { resolveCanonicalWorkspaceSlug } from "../workspace/canonical-workspace.js";
import { platformStateStore } from "../identity/platform-state-store.js";
import { logger } from "./logging.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      authTime?: number;
      user?: UserDocument;
      workspaceSlug?: string | null;
      isAdmin?: boolean;
    }
  }
}

let installedProvider: UserIdentityProvider | null = null;

export function installUserIdentityProvider(provider: UserIdentityProvider): void {
  installedProvider = provider;
}

export async function loadUserWithInstalledProvider(uid: string): Promise<UserDocument | null> {
  if (installedProvider === null) throw new Error("no user identity provider is installed");
  return installedProvider.loadUser(uid);
}

function userIdentityProvider(res: Response): UserIdentityProvider | null {
  if (installedProvider === null) {
    logger.error("User authentication is unavailable: no user identity provider is installed");
    res.status(503).json({ error: "Authentication unavailable" });
  }
  return installedProvider;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function authenticateUid(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const provider = userIdentityProvider(res);
  if (provider === null) return;

  const token = header.slice(7);
  void (async () => {
    let verified: VerifiedUser;
    try {
      verified = await provider.verifyBearer(token);
    } catch (err) {
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

export function requireRecentAuthentication(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authTime = req.authTime;
  if (
    typeof authTime !== "number" ||
    authTime > nowSeconds + 60 ||
    nowSeconds - authTime > RECENT_AUTH_MAX_AGE_SECONDS
  ) {
    res.status(403).json({
      error: "auth/requires-recent-login",
      message: "Recent authentication required",
    });
    return;
  }
  next();
}

export function requireAuthenticatedUid(req: Request, res: Response, next: NextFunction): void {
  authenticateUid(req, res, next);
}

function attachActiveUser(
  req: Request,
  res: Response,
  next: NextFunction,
  allowUnregistered: boolean,
): void {
  const provider = userIdentityProvider(res);
  if (provider === null) return;
  void (async () => {
    const userData = await provider.loadUser(req.uid!);
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

function attachAuthContext(req: Request, res: Response, next: NextFunction): void {
  const uid = req.uid!;
  void (async () => {
    req.workspaceSlug = await resolveCanonicalWorkspaceSlug(uid, req.user);
    try {
      req.isAdmin = (await platformStateStore.users.records.getRole(uid)) === "admin";
    } catch (err) {
      logger.warn(`Admin role lookup failed: ${(err as Error).message}`);
      req.isAdmin = false;
    }
    withLogContext(req.workspaceSlug ? { builderSlug: req.workspaceSlug } : {}, next);
  })().catch((err) => {
    logger.warn(`Auth lookup failed: ${err.message}`);
    res.status(503).json({ error: "Authentication lookup unavailable" });
  });
}

export function requireActiveAccount(req: Request, res: Response, next: NextFunction): void {
  if (!req.uid) { res.status(401).json({ error: "Unauthenticated" }); return; }
  attachActiveUser(req, res, () => attachAuthContext(req, res, next), false);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  requireAuthenticatedUid(req, res, () => {
    attachActiveUser(req, res, () => attachAuthContext(req, res, next), false);
  });
}

export function requireAuthAllowUnregistered(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  requireAuthenticatedUid(req, res, () => {
    attachActiveUser(req, res, () => attachAuthContext(req, res, next), true);
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
}

function boundTenantKind(req: Request): unknown {
  return (req as Request & { boundTenant?: { kind?: unknown } }).boundTenant?.kind;
}

export function requireInternalServiceAuth(req: Request, res: Response, next: NextFunction): void {
  if (boundTenantKind(req) === "gateway") {
    next();
    return;
  }
  res.status(401).json({ error: "internal auth required" });
}

export function requireInternalPlatformAuth(req: Request, res: Response, next: NextFunction): void {
  const kind = boundTenantKind(req);
  if (kind === "gateway" || kind === "platform") {
    next();
    return;
  }
  res.status(401).json({ error: "internal auth required" });
}

function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    return (
      a.length === b.length &&
      crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
    );
  } catch {
    return false;
  }
}

function bearerFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export function requireSocialNotificationAuth(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN;
  const provided = bearerFromRequest(req);
  if (configured && provided && timingSafeStringEqual(provided, configured)) {
    next();
    return;
  }
  res.status(401).json({ error: "invalid social notification bearer" });
}
