import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";

import { isConnectorAgentRuntimeTokenMaterializable } from "@octogee/core/connectors";
import {
  ConnectorTokenReadError,
  readOwnerGithubProjectCloneAccess,
  readOwnerRuntimeConnectorAccessToken,
} from "@octogee/core/connectors/connector-tokens";
import { cloneGithubProjectCheckout } from "../../lib/github-project-clone.js";
import { logger } from "@octogee/core/http/logging";
import { requireGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";
import { claimedUserIdentity } from "@octogee/core/identity/user-identity";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";


function gatewayConnectorRequestLimit(limit: number) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: () => "gateway-owner",
    message: { error: "Too many internal connector requests." },
  });
}

const credentialReviewLimit = rateLimit({
  windowMs: 60_000,
  limit: 1200,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  keyGenerator: () => "gateway",
  message: { error: "Too many internal connector authentication attempts." },
});

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isOwnerRuntimeGateway(): boolean {
  return isIsolatedGatewayClassValue(nonBlank(process.env.GATEWAY_CLASS));
}

function paramString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function tokenReadForbidden(err: unknown): boolean {
  return err instanceof ConnectorTokenReadError && err.status === 403;
}

function tokenReadReauthRequired(err: unknown): boolean {
  return err instanceof ConnectorTokenReadError && err.errorCode === "reauth_required";
}

function tokenReadUnavailable(err: unknown): err is ConnectorTokenReadError {
  return err instanceof ConnectorTokenReadError && (err.status === 403 || err.status === 503);
}

export function createInternalConnectorRoutes(): Router {
  const router = Router();
  router.get(
    "/:connector/materialize",
    credentialReviewLimit,
    requireGatewayInternalAuth,
    gatewayConnectorRequestLimit(600),
    async (req: Request, res: Response) => {
      const connectorId = paramString(req.params.connector);
      if (
        !connectorId
        || !isConnectorAgentRuntimeTokenMaterializable(connectorId)
      ) {
        res.status(403).json({ error: "forbidden", code: "connector_not_materializable" });
        return;
      }
      if (!isOwnerRuntimeGateway()) {
        res.status(403).json({ error: "forbidden", code: "owner_runtime_gateway_required" });
        return;
      }

      try {
        const accessToken = await readOwnerRuntimeConnectorAccessToken(connectorId);
        if (!accessToken) {
          res.status(404).json({
            status: "disconnected",
            connectorId,
            reason: "not_connected",
          });
          return;
        }

        res.json({ status: "connected", connectorId, accessToken });
      } catch (err) {
        if (tokenReadForbidden(err)) {
          logger.warn("[connectors/materialize] broker rejected owner-runtime token read", {
            connectorId,
          });
          res.status(403).json({ error: "forbidden" });
          return;
        }
        if (tokenReadReauthRequired(err)) {
          res.status(409).json({
            status: "disconnected",
            connectorId,
            reason: "reauth_required",
          });
          return;
        }
        logger.error("[connectors/materialize] materialization failed", {
          connectorId,
          err: err instanceof Error ? err.message : String(err),
        });
        res.status(502).json({ error: "connector materialization failed" });
      }
    },
  );

  router.post(
    "/github/clone",
    credentialReviewLimit,
    requireGatewayInternalAuth,
    gatewayConnectorRequestLimit(120),
    async (req: Request, res: Response) => {
      const projectSlug = paramString(req.body?.projectSlug);
      const builderSlug = paramString(req.body?.builderSlug);
      const expectedUserSlug = claimedUserIdentity()?.builderSlug;
      if (
        !projectSlug ||
        !builderSlug ||
        builderSlug !== expectedUserSlug ||
        !isOwnerRuntimeGateway()
      ) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      try {
        const access = await readOwnerGithubProjectCloneAccess(projectSlug);
        if (!access) {
          res.status(422).json({ error: "GitHub project clone unavailable", code: "OWNER_GITHUB_NOT_CONNECTED" });
          return;
        }
        const status = await cloneGithubProjectCheckout({
          usersRoot: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers",
          builderSlug,
          projectSlug,
          repository: access.repository,
          accessToken: access.accessToken,
        });
        res.status(status === "cloned" ? 201 : 200).json({ status });
      } catch (err) {
        if (tokenReadReauthRequired(err)) {
          res.status(409).json({ error: "reauth_required" });
          return;
        }
        if (tokenReadUnavailable(err)) {
          res.status(err.status).json({ error: err.errorCode });
          return;
        }
        logger.error("[connectors/github/clone] clone failed", {
          projectSlug,
          err: err instanceof Error ? err.message : String(err),
        });
        res.status(502).json({ error: "GitHub project clone failed" });
      }
    },
  );
  return router;
}
