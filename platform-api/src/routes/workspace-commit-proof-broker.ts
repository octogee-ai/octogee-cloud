import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";
import {
  verifyWorkspaceCommitProof,
  workspaceCommitProofTargetFromBody,
  type WorkspaceCommitProof,
  type WorkspaceCommitProofStore,
  type WorkspaceCommitProofTarget,
} from "../lib/workspace-commit-proof.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function proofBody(req: Request): WorkspaceCommitProof | null {
  const proof = (req.body as { proof?: unknown } | undefined)?.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  const data = proof as Record<string, unknown>;
  if (
    typeof data.timestamp !== "string" ||
    typeof data.signature !== "string" ||
    typeof data.body !== "string"
  ) return null;
  return { timestamp: data.timestamp, signature: data.signature, body: data.body };
}

function targetBody(req: Request): WorkspaceCommitProofTarget | null {
  const target = (req.body as { target?: unknown } | undefined)?.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const data = target as Record<string, unknown>;
  if (
    typeof data.agentId !== "string" ||
    typeof data.slug !== "string" ||
    !(typeof data.project === "string" || data.project === null)
  ) return null;
  return { agentId: data.agentId, slug: data.slug, project: data.project };
}

function targetsMatch(a: WorkspaceCommitProofTarget, b: WorkspaceCommitProofTarget): boolean {
  return a.agentId === b.agentId && a.slug === b.slug && a.project === b.project;
}

export function createWorkspaceCommitProofBrokerRoutes(opts: { store: WorkspaceCommitProofStore }): Router {
  const router = Router();

  router.post("/verify-proof", brokerRequestLimit(1800), async (req, res) => {
    if (!boundGateway(req, res)) return;
    const proof = proofBody(req);
    const requestedTarget = targetBody(req);
    if (!proof || !requestedTarget) {
      res.status(400).json({ error: "invalid_proof" });
      return;
    }
    const target = workspaceCommitProofTargetFromBody(proof.body);
    if (!target || !targetsMatch(requestedTarget, target)) {
      res.status(400).json({ error: "invalid_proof" });
      return;
    }
    try {
      const authorized = await verifyWorkspaceCommitProof(proof, target, opts.store);
      if (!authorized) {
        res.status(403).json(FORBIDDEN);
        return;
      }
      res.status(204).end();
    } catch {
      res.status(503).json({ error: "proof_unavailable" });
    }
  });

  return router;
}
