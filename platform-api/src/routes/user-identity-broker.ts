import { Router, type Request, type RequestHandler, type Response } from "express";
import type { UserDocument } from "@octogee/core/user-identity-provider";

import { requireAuthenticatedUid } from "../../../gateway-edge/src/middleware/auth.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { brokerRequestLimit } from "../middleware/broker-request-limit.js";

function boundGatewayId(req: Request): string | null {
  const bound = req.boundTenant;
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  return bound?.kind === "gateway" && claimed === bound.gatewayId ? bound.gatewayId : null;
}

export function createUserIdentityBrokerRoutes(opts: {
  loadUser: (uid: string) => Promise<UserDocument | null>;
}): Router {
  const router = Router();

  router.post("/verify", async (req: Request, res: Response) => {
    const gatewayId = boundGatewayId(req);
    if (gatewayId === null) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const uid = req.uid!;
    try {
      const user = await opts.loadUser(uid);
      res.set("cache-control", "no-store").json({ uid, authTime: req.authTime ?? null, user });
    } catch (error) {
      logger.error("[user-identity-broker] user lookup failed", { err: error, gatewayId });
      res.status(503).json({ error: "Authentication lookup unavailable" });
    }
  });

  return router;
}

export const USER_IDENTITY_GATEWAY_REQUEST_LIMIT = 6_000;

export function userIdentityBrokerHandlers(opts: {
  loadUser: (uid: string) => Promise<UserDocument | null>;
}): RequestHandler[] {
  return [
    brokerRequestLimit(USER_IDENTITY_GATEWAY_REQUEST_LIMIT, "gateway"),
    requireAuthenticatedUid,
    brokerRequestLimit(120, "user"),
    createUserIdentityBrokerRoutes(opts),
  ];
}
