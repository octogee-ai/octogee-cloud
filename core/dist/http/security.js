import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createDashboardAssetRateLimit } from "./dashboard-asset-rate-limit.js";
import { isDashboardAssetRequest } from "@octogee/shared/types/dashboard-asset-request";
export const helmetMiddleware = helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'none'"],
            baseUri: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false,
});
export const DEFAULT_RATE_LIMIT_OPTIONS = {
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipFailedRequests: false,
};
const SA_JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SA_JWT_MIN_LENGTH = 40;
const SA_JWT_MAX_LENGTH = 8192;
export function isWellFormedServiceAccountJwt(token) {
    if (token.length < SA_JWT_MIN_LENGTH || token.length > SA_JWT_MAX_LENGTH)
        return false;
    const segments = token.split(".");
    return segments.length === 3 && segments.every((segment) => SA_JWT_SEGMENT.test(segment));
}
const limitDashboardAssets = createDashboardAssetRateLimit();
export const dashboardAssetRateLimit = (req, res, next) => {
    if (isDashboardAssetRequest(req))
        return limitDashboardAssets(req, res, next);
    next();
};
export const strictRateLimit = rateLimit({
    ...DEFAULT_RATE_LIMIT_OPTIONS,
    windowMs: 60 * 1000,
    limit: 30,
    keyGenerator: (req) => req.uid ? `user:${req.uid}` : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
    message: { error: "Too many requests, please try again later." },
});
