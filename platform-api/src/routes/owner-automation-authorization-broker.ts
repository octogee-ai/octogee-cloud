import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";

import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import {
  createProductivityRateLimiter,
  type ProductivityRateLimiter,
} from "../lib/agent-productivity/rate-limit.js";
import {
  authorizeOwnerAutomation,
  type AssignedUserLookup,
  type OwnerAutomationProof,
} from "../lib/owner-automation-authorization.js";
import { findAssignedUserByAgentId } from "./fleet-broker.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (!bound || bound.kind !== "gateway" || claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function proofBody(req: Request): OwnerAutomationProof | null {
  const proof = (req.body as { proof?: unknown } | undefined)?.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const data = proof as Record<string, unknown>;
  if (
    typeof data.timestamp !== "string" ||
    typeof data.signature !== "string" ||
    typeof data.body !== "string" ||
    data.body.length > 16_384
  ) return null;
  return { timestamp: data.timestamp, signature: data.signature, body: data.body };
}

export function createOwnerAutomationAuthorizationBrokerRoutes(opts: {
  store: PlatformStateRepositories;
  findAssignedUser?: AssignedUserLookup;
  rateLimiter?: ProductivityRateLimiter;
  now?: () => number;
}): Router {
  const router = Router();
  const findAssignedUser = opts.findAssignedUser ?? findAssignedUserByAgentId;
  const rateLimiter = opts.rateLimiter ?? createProductivityRateLimiter();

  router.post("/authorize", brokerRequestLimit(2400), async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const proof = proofBody(req);
    if (!proof) {
      res.status(400).json({ error: "invalid_proof" });
      return;
    }
    try {
      const authorization = await authorizeOwnerAutomation(opts.store, bound.gatewayId, proof, {
        findAssignedUser,
        now: opts.now,
      });
      if (!authorization) {
        logger.warn("[owner-automations] rejected owner automation request", { gatewayId: bound.gatewayId });
        res.status(403).json(FORBIDDEN);
        return;
      }
      const { readOnly, ...tenant } = authorization;
      const rateLimit = rateLimiter.consume(bound.gatewayId, tenant.agentId, readOnly ? "read" : "write");
      if (!rateLimit.allowed) {
        res.status(429).json({ error: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return;
      }
      res.json({ gatewayId: bound.gatewayId, ...tenant });
    } catch (error) {
      logger.error("[owner-automations] authorization failed", { err: error, gatewayId: bound.gatewayId });
      res.status(503).json({ error: "authorization_unavailable" });
    }
  });

  return router;
}
