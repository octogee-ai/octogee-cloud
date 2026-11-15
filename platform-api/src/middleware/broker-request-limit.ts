import { rateLimit, type AugmentedRequest } from "express-rate-limit";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";

export function brokerRequestLimit(limit: number, scope: "gateway" | "user" = "gateway") {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: req => !req.boundTenant || (scope === "user" && !req.uid),
    keyGenerator: req => {
      const tenant = req.boundTenant!;
      const identity = tenant.kind === "gateway" ? [tenant.kind, tenant.gatewayId] : [tenant.kind, tenant.actor];
      return JSON.stringify(scope === "user" ? [...identity, req.uid] : identity);
    },
    handler: (req, res, _next, options) => {
      const tenant = req.boundTenant!;
      if ((req as AugmentedRequest).rateLimit.used === limit + 1) {
        logger.warn("[broker-request-limit] refused a tenant over its limit", {
          ...(tenant.kind === "gateway" ? { gatewayId: tenant.gatewayId } : { actor: tenant.actor }),
          scope,
          limit,
          path: req.baseUrl,
        });
      }
      res.status(options.statusCode).json(options.message);
    },
    message: { error: "rate_limited" },
  });
}
