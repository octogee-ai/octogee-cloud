import { Options as RateLimitOptions } from "express-rate-limit";
import type { RequestHandler } from "express";
export declare const helmetMiddleware: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, next: (err?: unknown) => void) => void;
export declare const DEFAULT_RATE_LIMIT_OPTIONS: Partial<RateLimitOptions>;
export declare function isWellFormedServiceAccountJwt(token: string): boolean;
export declare const dashboardAssetRateLimit: RequestHandler;
export declare const strictRateLimit: import("express-rate-limit").RateLimitRequestHandler;
