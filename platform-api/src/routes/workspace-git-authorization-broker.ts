import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";

import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import {
  resolveFileTarget,
  type FileTargetResult,
  type ResolveFileTargetOpts,
} from "../../../gateway-edge/src/lib/fileTarget.js";
import type {
  WorkspaceGitAuthorization,
  WorkspaceGitLane,
} from "../../../gateway-edge/src/lib/workspace-git-authorization-broker.js";
import { resolveCommitAuthor } from "../../../gateway-edge/src/routes/workspace/helpers.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const NOT_FOUND = { error: "not_found" } as const;

interface AuthorizeBody {
  gatewayId: string;
  slug: string;
  projectSlug: string | null;
  lane: WorkspaceGitLane;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseBody(value: unknown): AuthorizeBody | null {
  const body = record(value);
  if (
    !body ||
    !isValidGatewayId(body.gatewayId) ||
    !isValidUsername(body.slug) ||
    (body.projectSlug !== null && !isValidProjectId(body.projectSlug)) ||
    (body.access !== "read" && body.access !== "write") ||
    typeof body.resolveGithubToken !== "boolean"
  ) return null;
  return {
    gatewayId: body.gatewayId,
    slug: body.slug,
    projectSlug: body.projectSlug,
    lane: { access: body.access, resolveGithubToken: body.resolveGithubToken },
  };
}

function boundGateway(req: Request, gatewayId: string): GatewayBinding | null {
  const bound = req.boundTenant;
  return bound && bound.kind === "gateway" && bound.gatewayId === gatewayId ? bound : null;
}

function safeUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/");
}

export interface WorkspaceGitAuthorizationBrokerDeps {
  store: PlatformStateRepositories;
  resolveTarget?: (
    input: Parameters<typeof resolveFileTarget>[0],
    opts: ResolveFileTargetOpts,
  ) => Promise<FileTargetResult>;
}

async function authorize(req: Request, res: Response, deps: WorkspaceGitAuthorizationBrokerDeps): Promise<void> {
  const body = parseBody(req.body);
  if (!body) {
    res.status(400).json({ error: "invalid workspace git authorization request" });
    return;
  }
  if (!boundGateway(req, body.gatewayId)) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  if (!safeUid(req.uid)) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const assigned = await deps.store.users.records.listByGateway(body.gatewayId);
  if (!assigned.some((user) => user.slug === body.slug)) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  const resolveTarget = deps.resolveTarget ?? resolveFileTarget;
  const result = await resolveTarget(
    {
      slug: body.slug,
      projectSlug: body.projectSlug,
      callerUid: req.uid,
      callerWorkspaceSlug: req.workspaceSlug,
    },
    body.lane,
  );
  if (!result.ok) {
    res.status(result.status).json({
      error: result.error,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return;
  }
  const authorization: WorkspaceGitAuthorization = {
    gatewayId: body.gatewayId,
    uid: req.uid,
    slug: body.slug,
    projectSlug: body.projectSlug,
    githubToken: result.target.githubToken ?? null,
    commitAuthor: resolveCommitAuthor(req.user, body.slug),
  };
  res.set("cache-control", "no-store").json(authorization);
}

export function createWorkspaceGitAuthorizationBrokerRoutes(deps: WorkspaceGitAuthorizationBrokerDeps): Router {
  const router = Router();

  router.post("/authorize", brokerRequestLimit(360, "user"), async (req, res, next) => {
    try {
      await authorize(req, res, deps);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
