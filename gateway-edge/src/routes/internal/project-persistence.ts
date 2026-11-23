import { clientRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router } from "express";
import { createGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";
import { persistUserProjects, persistSharedUserFiles } from "../../lib/project-persistence.js";
import { isValidUsername } from "@octogee/shared/types/identity";
import { logger } from "@octogee/core/http/logging";
import { claimedUserIdentity } from "@octogee/core/identity/user-identity";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export function createProjectPersistenceRouter(
  persistProjects = persistUserProjects,
  persistManaged = persistSharedUserFiles,
): Router {
  const router = Router();
  router.use(clientRequestLimit(600, true), createGatewayInternalAuth({ allowSharedGateway: true }));
  router.post("/flush", async (req, res) => {
    const shared = process.env.GATEWAY_CLASS === "shared";
    const slug = req.body?.slug;
    if (shared && !isValidUsername(slug)) {
      res.status(400).json({ error: "invalid project owner" });
      return;
    }
    if (!shared && (!isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS) ||
        !slug || slug !== claimedUserIdentity()?.builderSlug)) {
      res.status(403).json({ error: "project owner differs from this user" });
      return;
    }
    const persist = shared || process.env.GATEWAY_EPHEMERAL_HOME === "true" ? persistManaged : persistProjects;
    try {
      res.json(await persist({ root: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", slug }));
    } catch (error) {
      logger.error("workspace checkpoint failed; local work must be retained", { slug, error: String(error) });
      res.status(503).json({ error: "Workspace remote save failed; local work retained" });
    }
  });
  return router;
}
