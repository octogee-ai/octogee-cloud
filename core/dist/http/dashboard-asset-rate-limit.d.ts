import type { RequestHandler } from "express";
export declare function createDashboardAssetRateLimit({ now, maxKeys, }?: {
    now?: () => number;
    maxKeys?: number;
}): RequestHandler;
