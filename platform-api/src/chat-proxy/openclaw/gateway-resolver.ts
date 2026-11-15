import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";

export type GatewayResolveErrorCode =
  | "workspace-moving"
  | "user-not-provisioned"
  | "gateway-not-registered"
  | "gateway-root-invalid"
  | "gateway-url-unresolved";

export class GatewayResolveError extends Error {
  override readonly name = "GatewayResolveError";
  constructor(
    readonly code: GatewayResolveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type GatewayResolverState = Pick<PlatformStateRepositories, "users" | "gateways" | "fleetRegistry">;

export interface ResolveGatewayOptions {
  store: GatewayResolverState;
  uid: string;
  overrideUrl?: string;
}

export interface ResolvedGateway {
  gatewayId: string;
  url: string;
}

export type ResolvedGatewayAssignment = Omit<ResolvedGateway, "url">;

function withoutRevision(record: object): Record<string, unknown> {
  const { revision: _revision, ...data } = record as Record<string, unknown>;
  return data;
}

function unresolvedGatewayUrl(gatewayId: string, detail: string): never {
  throw new GatewayResolveError(
    "gateway-url-unresolved",
    `gateways/${gatewayId} ${detail}`,
  );
}

function assertRunningGateway(gatewayId: string, desiredStatus: string): void {
  if (desiredStatus === "running") return;
  throw new GatewayResolveError(
    desiredStatus === "draining" ? "workspace-moving" : "gateway-url-unresolved",
    `gateways/${gatewayId} is ${desiredStatus}`,
  );
}

async function readProvisionedGatewayId(
  store: GatewayResolverState,
  uid: string,
): Promise<string> {
  const user = await store.users.records.get(uid);
  const gatewayId = user?.gateway?.gatewayId;
  if (gatewayId === undefined || gatewayId.length === 0) {
    throw new GatewayResolveError(
      "user-not-provisioned",
      `users/${uid} has no provisioning.openclaw.gatewayId`,
    );
  }
  return gatewayId;
}

async function readRuntimeUrl(
  store: GatewayResolverState,
  gatewayId: string,
): Promise<string> {
  const runtime = await store.fleetRegistry.get(gatewayId);
  if (runtime === null) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `glmGateways/${gatewayId} has no runtime realization`,
    );
  }
  if (runtime.lifecycle !== "serving") {
    unresolvedGatewayUrl(gatewayId, "does not have a serving runtime realization");
  }
  const internalUrl = runtime.heartbeat.internalUrl ?? "";
  if (internalUrl.length === 0) {
    throw new GatewayResolveError(
      "gateway-url-unresolved",
      `glmGateways/${gatewayId}.heartbeat.internalUrl is empty — refusing to fall back to the round-robin alias`,
    );
  }
  return internalUrl;
}

async function assertResolvableGateway(
  store: GatewayResolverState,
  gatewayId: string,
  uid: string,
  requireServingAssignment: boolean,
): Promise<void> {
  const root = await store.gateways.roots.get(gatewayId);
  if (root === null) {
    throw new GatewayResolveError(
      "gateway-not-registered",
      `gateways/${gatewayId} does not exist`,
    );
  }
  if (projectGatewayDesiredRootForGateway(withoutRevision(root), gatewayId) === null) {
    throw new GatewayResolveError(
      "gateway-root-invalid",
      `gateways/${gatewayId} exists but is not a valid durable root`,
    );
  }
  assertRunningGateway(gatewayId, root.desiredStatus);
  const assignment = await store.gateways.assignments.get(gatewayId, uid);
  if (assignment === null) {
    if (requireServingAssignment) {
      unresolvedGatewayUrl(gatewayId, `has no serving assignment for ${uid}`);
    }
    return;
  }
  if (assignment.state !== "serving") {
    unresolvedGatewayUrl(gatewayId, `has a non-serving assignment for ${uid}`);
  }
}

export async function resolveGatewayAssignment(
  opts: Pick<ResolveGatewayOptions, "store" | "uid">,
): Promise<ResolvedGatewayAssignment> {
  const gatewayId = await readProvisionedGatewayId(opts.store, opts.uid);
  await assertResolvableGateway(opts.store, gatewayId, opts.uid, true);
  return { gatewayId };
}

export async function resolveGatewayUrl(
  opts: ResolveGatewayOptions,
): Promise<ResolvedGateway> {
  const gatewayId = await readProvisionedGatewayId(opts.store, opts.uid);
  const overrideUrl = opts.overrideUrl ?? process.env.OPENCLAW_GATEWAY_URL;
  if (typeof overrideUrl === "string" && overrideUrl.length > 0) {
    return { gatewayId, url: overrideUrl };
  }
  await assertResolvableGateway(opts.store, gatewayId, opts.uid, false);
  return { gatewayId, url: await readRuntimeUrl(opts.store, gatewayId) };
}
