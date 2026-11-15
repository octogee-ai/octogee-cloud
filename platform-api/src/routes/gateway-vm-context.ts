import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { Router, type Request, type Response } from "express";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import type { PlatformUserRecord, PlatformStateRepositories, Stored } from "@octogee/core/platform-state";
import { resolveGatewayClass } from "@octogee/shared/types/glm";
import { parseAgentId, mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";
import { isSafeAgentId } from "@octogee/core/byosub-restore";
import { userAssignedToGateway } from "../lib/assigned-user.js";
import { findAssignedUserByAgentId } from "./fleet-broker.js";

const FORBIDDEN = { error: "forbidden" } as const;
interface AgentOwnerContext {
  gatewayId: string;
  ownerUid: string;
  workspaceSlug: string;
  agentId: string;
  owner: Stored<PlatformUserRecord>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function value(req: Request, key: string): unknown {
  return record(req.body)?.[key] ?? req.query[key];
}

function agentRequestContext(
  req: Request,
  res: Response,
): { gatewayId: string; agentId: string } | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const agentId = value(req, "agentId");
  if (typeof agentId !== "string" || !isSafeAgentId(agentId)) {
    res.status(400).json({ error: "valid agentId required" });
    return null;
  }
  if (parseAgentId(agentId).kind !== "coach") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return { gatewayId: bound.gatewayId, agentId };
}

async function assignedAgentOwnerContext(
  store: PlatformStateRepositories,
  gatewayId: string,
  agentId: string,
): Promise<AgentOwnerContext | null> {
  const assigned = await findAssignedUserByAgentId(store, gatewayId, agentId);
  if (!assigned) {
    return null;
  }
  const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
  const workspaceSlug = assigned.slug;
  if (!authorization || !workspaceSlug) {
    return null;
  }
  const gatewayClass = resolveGatewayClass({
    gatewayClass: authorization.config.gatewayClass,
    profile: authorization.config.profile ?? undefined,
    imageProfile: authorization.config.imageProfile,
  });
  if (!userAssignedToGateway(assigned, gatewayId, workspaceSlug)) return null;
  if (gatewayClass === "shared") {
    const workspace = await store.workspaces.records.get(workspaceSlug);
    if (workspace?.ownerUid !== assigned.uid) return null;
  } else if (authorization.config.ownerUid !== assigned.uid ||
    authorization.config.builderSlug !== workspaceSlug) {
    return null;
  }
  return {
    gatewayId,
    ownerUid: assigned.uid,
    workspaceSlug,
    agentId,
    owner: assigned,
  };
}

function runningPodInstanceId(live: Record<string, unknown>, podUid: string | undefined): string | null {
  if (!podUid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(podUid)) return null;
  const observed = record(live.kubernetes);
  if (!observed || observed.status !== "ready" || observed.totalPods !== 1 || observed.readyPods !== 1) return null;
  const pods = observed.pods;
  if (!Array.isArray(pods) || pods.length !== 1 || record(pods[0])?.uid !== podUid) return null;
  return `cluster:${podUid}`;
}

function runningRuntimeInstanceId(live: Record<string, unknown> | undefined, podUid: string | undefined): string | null {
  if (live?.runtime === "cluster") return runningPodInstanceId(live, podUid);
  const vm = record(live?.vm);
  if (live?.runtime !== "gce-vm" || vm?.status !== "RUNNING" ||
    typeof vm.instanceId !== "string" || !/^\d+$/u.test(vm.instanceId)) return null;
  return `gce-vm:${vm.instanceId}`;
}

export function createGatewayVmContextRoutes(args: { store: PlatformStateRepositories }): Router {
  const router = Router();
  router.post("/agent-context", brokerRequestLimit(1200), async (req, res) => {
    const request = agentRequestContext(req, res);
    if (!request) return;
    const context = await assignedAgentOwnerContext(args.store, request.gatewayId, request.agentId);
    if (!context) { res.status(403).json(FORBIDDEN); return; }
    const [authorization, fleet] = await Promise.all([
      readGatewayAuthorizationInStore(args.store, context.gatewayId),
      args.store.fleetRegistry.get(context.gatewayId),
    ]);
    const agentAccountId = mattermostAccountIdForAgentId(context.agentId);
    if (!authorization || authorization.config.ownerUid !== context.ownerUid || !agentAccountId) {
      res.status(403).json(FORBIDDEN); return;
    }
    const bound = req.boundTenant;
    const computerInstanceId = runningRuntimeInstanceId(record(fleet) ?? undefined, bound?.kind === "gateway" ? bound.podUid : undefined);
    if (authorization.gateway.desiredStatus !== "running" || !computerInstanceId) {
      res.status(409).json({ error: "computer-unavailable" }); return;
    }
    const ownerMattermostUserId = context.owner.mattermostUserId;
    res.json({
      gatewayId: context.gatewayId, ownerUid: context.ownerUid, computerInstanceId, agentAccountId,
      ...(computerInstanceId.startsWith("gce-vm:") ? { vmInstanceId: computerInstanceId.slice("gce-vm:".length) } : {}),
      ownerMattermostUserId: ownerMattermostUserId !== null && /^[a-z0-9]{26}$/u.test(ownerMattermostUserId)
        ? ownerMattermostUserId : null,
    });
  });

  return router;
}
