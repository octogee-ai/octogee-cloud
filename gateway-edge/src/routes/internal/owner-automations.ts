import { clientRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, type Request, type Response } from "express";

import { logger } from "@octogee/core/http/logging";
import {
  authorizeOwnerAutomationViaBroker,
  type OwnerAutomationAuthorizationOutcome,
} from "../../lib/owner-automation-authorization-broker.js";
import { AutomationBrokerError, automationRecord, type AutomationInvoke } from "../automation-native.js";
import { invokeLocalOpenClaw, NativeAutomationError } from "../automations.js";
import {
  executeOwnerAutomation,
  parseOwnerAutomationRequest,
  type OwnerAutomationRequest,
} from "../owner-automation-jobs.js";

export interface OwnerAutomationRouterDeps {
  authorize(req: Request, agentId: string): Promise<OwnerAutomationAuthorizationOutcome>;
  invoke: AutomationInvoke;
}

const BODY_FIELDS = ["agentId", "requestContext", "action", "params"];

function parseBody(req: Request): { agentId: string; request: OwnerAutomationRequest } {
  const body = automationRecord(req.body);
  const keys = body ? Object.keys(body) : [];
  if (!body || keys.length !== BODY_FIELDS.length || !BODY_FIELDS.every((key) => keys.includes(key)) ||
    typeof body.agentId !== "string") {
    throw new AutomationBrokerError(400, "invalid_owner_automation");
  }
  return { agentId: body.agentId, request: parseOwnerAutomationRequest(body.action, body.params) };
}

function sendError(res: Response, error: unknown): boolean {
  if (error instanceof AutomationBrokerError) {
    res.status(error.status).json({ error: error.code });
    return true;
  }
  if (error instanceof NativeAutomationError) {
    res.status(error.native.code === "INVALID_REQUEST" ? 400 : 502)
      .json({ error: "native_automation_error", code: error.native.code, message: error.message });
    return true;
  }
  return false;
}

export function createOwnerAutomationRouter(deps: OwnerAutomationRouterDeps): Router {
  const router = Router();
  router.post("/", clientRequestLimit(1200, true), async (req, res) => {
    try {
      const { agentId, request } = parseBody(req);
      const outcome = await deps.authorize(req, agentId);
      if (outcome.kind === "forbidden") {
        res.status(403).json({ error: "owner_automation_forbidden" });
        return;
      }
      if (outcome.kind === "rate_limited") {
        res.status(429).json({ error: "rate_limited", retryAfterSeconds: outcome.retryAfterSeconds });
        return;
      }
      res.json({ result: await executeOwnerAutomation(deps.invoke, outcome.tenant, request) });
    } catch (error) {
      if (sendError(res, error)) return;
      logger.error("internal/owner-automations: request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({ error: "owner_automation_unavailable" });
    }
  });
  return router;
}

export default createOwnerAutomationRouter({
  authorize: (req, agentId) => authorizeOwnerAutomationViaBroker(req, agentId),
  invoke: invokeLocalOpenClaw,
});
