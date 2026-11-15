import { Router, Request, Response, NextFunction } from "express";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import type { GatewayRoot, Stored } from "@octogee/core/platform-state";
import {
  WORKSPACE_GATEWAY_STATUS_MAX_SLUGS,
  type WorkspaceGatewayStatus,
  type WorkspaceGatewayStatusResponse,
} from "@octogee/shared/types/gateway-control";
import { isValidUsername } from "@octogee/shared/types/identity";
import { resolveGatewayClass } from "@octogee/shared/types/glm";
import {
  gatewayAuthorizationFromRootDocument,
  readGatewayRuntimeDoc,
} from "@octogee/core/gateway-live-release";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import {
  projectGatewayRuntimeStatus,
  projectOwnerActivation,
} from "../../lib/gateway-runtime-status.js";

type RequestedSlugs =
  | { kind: "ok"; slugs: string[] }
  | { kind: "invalid"; error: string };

export function parseRequestedWorkspaceSlugs(raw: unknown): RequestedSlugs {
  if (raw === undefined) return { kind: "ok", slugs: [] };
  if (typeof raw !== "string") return { kind: "invalid", error: "invalid-workspace-slug" };
  const slugs = [...new Set(raw.split(",").map((slug) => slug.trim()).filter((slug) => slug.length > 0))];
  if (slugs.length > WORKSPACE_GATEWAY_STATUS_MAX_SLUGS) return { kind: "invalid", error: "too-many-workspaces" };
  if (!slugs.every((slug) => isValidUsername(slug))) return { kind: "invalid", error: "invalid-workspace-slug" };
  return { kind: "ok", slugs };
}

async function memberWorkspaceSlugs(uid: string): Promise<Set<string>> {
  const [workspaceMemberships, projectMemberships] = await Promise.all([
    platformStateStore.workspaces.members.listForUid(uid),
    platformStateStore.workspaces.projectMembers.listForUid(uid),
  ]);
  const slugs = new Set<string>();
  for (const membership of workspaceMemberships) {
    if (isCanonicalWorkspaceMembership(membership)) slugs.add(membership.workspaceSlug);
  }
  for (const membership of projectMemberships) slugs.add(membership.workspaceSlug);
  return slugs;
}

async function workspaceGatewayStatus(
  workspaceSlug: string,
  ownerUid: string,
  now: number,
): Promise<WorkspaceGatewayStatus> {
  const owner = await platformStateStore.users.records.get(ownerUid);
  const activation = projectOwnerActivation(owner?.activationLease ?? null);
  const assignedGatewayId = owner?.gateway?.gatewayId;
  const gatewayId = assignedGatewayId && owner.slug === workspaceSlug ? assignedGatewayId : null;
  if (!gatewayId) {
    return { workspaceSlug, gatewayId: null, gatewayClass: null, runtimeStatus: "unknown", activation };
  }
  const root = await platformStateStore.gateways.roots.get(gatewayId);
  const authorization = root ? gatewayAuthorizationFromRootDocument(rootDocument(root), gatewayId) : null;
  if (!authorization) {
    return { workspaceSlug, gatewayId, gatewayClass: null, runtimeStatus: "unknown", activation };
  }
  const runtime = await readGatewayRuntimeDoc(platformStateStore, authorization.gateway);
  return {
    workspaceSlug,
    gatewayId,
    gatewayClass: resolveGatewayClass({
      gatewayClass: authorization.config.gatewayClass,
      profile: authorization.config.profile ?? undefined,
      imageProfile: authorization.config.imageProfile,
    }),
    runtimeStatus: projectGatewayRuntimeStatus(runtime, { gatewayId, now }),
    activation,
  };
}

function rootDocument(root: Stored<GatewayRoot>): Record<string, unknown> {
  const { revision: _revision, ...document } = root;
  return document;
}

export async function workspaceGatewayStatusesFor(
  uid: string,
  slugs: string[],
  now = Date.now(),
): Promise<WorkspaceGatewayStatus[]> {
  if (slugs.length === 0) return [];
  const memberOf = await memberWorkspaceSlugs(uid);
  const statuses = await Promise.all(slugs.map(async (workspaceSlug) => {
    const ownerUid = (await platformStateStore.workspaces.records.get(workspaceSlug))?.ownerUid;
    if (!ownerUid) return null;
    if (ownerUid !== uid && !memberOf.has(workspaceSlug)) return null;
    return workspaceGatewayStatus(workspaceSlug, ownerUid, now);
  }));
  return statuses.filter((status): status is WorkspaceGatewayStatus => status !== null);
}

export function registerWorkspaceGatewayStatusRoute(router: Router): void {
  router.get("/workspaces/gateway-status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requested = parseRequestedWorkspaceSlugs(req.query.slugs);
      if (requested.kind === "invalid") {
        res.status(400).json({ error: requested.error });
        return;
      }
      const body: WorkspaceGatewayStatusResponse = {
        workspaces: await workspaceGatewayStatusesFor(req.uid!, requested.slugs),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
}
