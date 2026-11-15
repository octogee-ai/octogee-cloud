import { Request, Response, NextFunction } from "express";
import { type UserDocument, type UserIdentityProvider } from "../user-identity-provider.js";
declare global {
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
export declare function installUserIdentityProvider(provider: UserIdentityProvider): void;
export declare function loadUserWithInstalledProvider(uid: string): Promise<UserDocument | null>;
export declare const RECENT_AUTH_MAX_AGE_SECONDS: number;
export declare function requireRecentAuthentication(req: Request, res: Response, next: NextFunction): void;
export declare function requireAuthenticatedUid(req: Request, res: Response, next: NextFunction): void;
export declare function requireActiveAccount(req: Request, res: Response, next: NextFunction): void;
export declare function requireAuth(req: Request, res: Response, next: NextFunction): void;
export declare function requireAuthAllowUnregistered(req: Request, res: Response, next: NextFunction): void;
export declare function requireAdmin(req: Request, res: Response, next: NextFunction): void;
export declare function requireInternalServiceAuth(req: Request, res: Response, next: NextFunction): void;
export declare function requireInternalPlatformAuth(req: Request, res: Response, next: NextFunction): void;
export declare function requireSocialNotificationAuth(req: Request, res: Response, next: NextFunction): void;
