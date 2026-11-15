import type { Request, Response, NextFunction } from "express";
import type { UserAccount, UserAccountReader } from "@octogee/core/user-account";
import type { IdentityProvider, VerifiedIdentity } from "@octogee/core/identity-provider";
import type { PlatformUserRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

export interface RequireAdminDeps {
  identity: IdentityProvider;
  store: Pick<PlatformStateStore, "users">;
  accounts: Pick<UserAccountReader, "get">;
  log: (msg: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function authenticatedIdentity(
  deps: RequireAdminDeps,
  req: Request,
  res: Response,
): Promise<VerifiedIdentity | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  try {
    return await deps.identity.verifyBearer(header.slice(7));
  } catch (error) {
    deps.log(`[admin-auth] verify failed: ${errorMessage(error)}`);
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      user?: { email?: string | null };
      isAdmin?: boolean;
    }
  }
}

export function createRequireAdmin(
  deps: RequireAdminDeps,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function requireAdmin(req, res, next) {
    const identity = await authenticatedIdentity(deps, req, res);
    if (!identity) return;
    const uid = identity.ownerId;
    req.uid = uid;
    if (identity.operator) {
      req.user = { email: identity.email };
      req.isAdmin = true;
      next();
      return;
    }

    let userRecord: Stored<PlatformUserRecord> | null;
    let account: UserAccount | null;
    try {
      [userRecord, account] = await Promise.all([
        deps.store.users.records.get(uid),
        deps.accounts.get(uid),
      ]);
    } catch (error) {
      const message = errorMessage(error);
      deps.log(`[admin-auth] role lookup failed uid=${uid}: ${message}`);
      next(error instanceof Error ? error : new Error(message));
      return;
    }
    if (userRecord === null || !accountAllowsInteractiveAccess({ accountLifecycle: userRecord.accountLifecycle })) {
      res.status(403).json({ error: "Account suspended" });
      return;
    }
    req.user = { email: account?.email ?? null };
    req.isAdmin = userRecord.role === "admin";

    if (!req.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };
}
