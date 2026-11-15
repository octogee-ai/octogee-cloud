import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";

import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";
import { userAllowsInteractiveAccess } from "../lib/assigned-user.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const MATTERMOST_ID = /^[a-z0-9]{26}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  const body = record(req.body);
  if (
    !bound ||
    bound.kind !== "gateway" ||
    !body ||
    Object.keys(body).length !== 1 ||
    !isValidGatewayId(body.gatewayId) ||
    body.gatewayId !== bound.gatewayId
  ) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function safeUid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("/");
}

function authorizationContext(
  req: Request,
  res: Response,
): { bound: GatewayBinding; uid: string } | null {
  const bound = boundGateway(req, res);
  if (!bound) return null;
  if (!safeUid(req.uid)) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (bound.ownerUid && bound.ownerUid !== req.uid) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { bound, uid: req.uid };
}

type AutomationAuthorizationStore = Pick<PlatformStateRepositories, "users" | "workspaces">;

async function assignedOwnerSlug(
  store: AutomationAuthorizationStore,
  uid: string,
  gatewayId: string,
): Promise<{ slug: string | null; active: boolean }> {
  const user = await store.users.records.get(uid);
  if (user && !userAllowsInteractiveAccess(user)) return { slug: null, active: false };
  const slug = user?.slug ?? null;
  if (!slug || !isValidUsername(slug) || user?.gateway?.gatewayId !== gatewayId) {
    return { slug: null, active: true };
  }
  return { slug, active: true };
}

async function isWorkspaceOwner(store: AutomationAuthorizationStore, slug: string, uid: string): Promise<boolean> {
  const workspace = await store.workspaces.records.get(slug);
  return workspace?.ownerUid === uid;
}

async function coachChannelId(store: AutomationAuthorizationStore, slug: string): Promise<string | null> {
  const channel = await store.workspaces.channels.get({ workspaceSlug: slug, projectSlug: null }, "coach-dm");
  const channelId = channel?.mattermostChannelId;
  return typeof channelId === "string" && MATTERMOST_ID.test(channelId) ? channelId : null;
}

async function authorizeRequest(req: Request, res: Response, store: AutomationAuthorizationStore): Promise<void> {
  const context = authorizationContext(req, res);
  if (!context) return;
  const assignment = await assignedOwnerSlug(store, context.uid, context.bound.gatewayId);
  if (!assignment.active) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const { slug } = assignment;
  if (!slug) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (!await isWorkspaceOwner(store, slug, context.uid)) {
    res.status(403).json(FORBIDDEN);
    return;
  }
  const authorizedDefaultAgentChannelId = await coachChannelId(store, slug);
  if (!authorizedDefaultAgentChannelId) {
    res.status(409).json({ error: "coach_channel_not_ready" });
    return;
  }
  res.json({
    slug,
    gatewayId: context.bound.gatewayId,
    coachChannelId: authorizedDefaultAgentChannelId,
  });
}

export function createAutomationAuthorizationBrokerRoutes(opts: { store: AutomationAuthorizationStore }): Router {
  const router = Router();

  router.post("/authorize", brokerRequestLimit(360, "user"), async (req, res, next) => {
    try {
      await authorizeRequest(req, res, opts.store);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
