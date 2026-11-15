import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { Router, type Request, type RequestHandler } from "express";
import {
  USER_VISIBLE_FEATURE_FLAG_KEYS,
  type FeatureSubject,
} from "@octogee/shared/types/feature-flags";
import { requireActiveAccount, requireAuthenticatedUid } from "../../../gateway-edge/src/middleware/auth.js";
import { FeaturePolicy } from "../lib/feature-policy.js";

function subject(req: Request): FeatureSubject {
  return {
    uid: req.uid!,
    isAdmin: req.isAdmin === true,
    ...(typeof req.workspaceSlug === "string" ? { workspaceSlug: req.workspaceSlug } : {}),
  };
}

export function createFeatureRoutes({
  featurePolicy,
  auth = requireAuthenticatedUid,
  requireAccount = requireActiveAccount,
}: {
  featurePolicy: FeaturePolicy;
  auth?: RequestHandler;
  requireAccount?: RequestHandler;
}): Router {
  const router = Router();
  router.get("/", authenticationFailureLimit, auth, authenticatedRequestLimit(120), requireAccount, async (req, res, next) => {
    try {
      const decisions = await featurePolicy.userVisibleDecisions(subject(req), "pwa-snapshot");
      if (USER_VISIBLE_FEATURE_FLAG_KEYS.some((key) => decisions[key].state === "unavailable")) {
        res.status(503).json({ error: "feature_evaluation_unavailable" });
        return;
      }
      res.set("Cache-Control", "no-store");
      res.json({
        flags: Object.fromEntries(USER_VISIBLE_FEATURE_FLAG_KEYS.map((key) => [
          key,
          decisions[key].state === "enabled",
        ])),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
