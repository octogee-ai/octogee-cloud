import { clientRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router } from "express";
import { createGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";
import { persistUserProjects, persistSharedUserFiles } from "../../lib/project-persistence.js";
import { isValidUsername } from "@octogee/shared/types/identity";
import { logger } from "@octogee/core/http/logging";
import { claimedUserIdentity } from "@octogee/core/identity/user-identity";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export function createProjectPersistenceRouter(persist = persistUserProjects): Router {
  const router = Router();
  router.use(clientRequestLimit(600, true), createGatewayInternalAuth({ allowSharedGateway: true }));
  router.post("/flush", async (req, res) => {
    if (process.env.GATEWAY_CLASS === "shared") {
      if (!isValidUsername(req.body?.slug)) { res.status(400).json({ error: "invalid project owner" }); return; }
      try {
        res.json(await persistSharedUserFiles({ root: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", slug: req.body.slug }));
      } catch (error) {
        logger.error("Shared checkpoint failed; local work must be retained", { slug: req.body.slug, error: String(error) });
        res.status(503).json({ error: "Shared remote save failed; local work retained" });
      }
      return;
    }
    const slug = claimedUserIdentity()?.builderSlug;
    if (!isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS) || !slug || req.body?.slug !== slug) {
      res.status(403).json({ error: "project owner differs from this user" });
      return;
    }
    try {
      res.json(await persist({ root: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", slug }));
    } catch (error) {
      logger.error("project persistence failed; local work must be retained", { slug, error: String(error) });
      res.status(503).json({ error: "Project remote save failed; local work retained" });
    }
  });
  return router;
}
