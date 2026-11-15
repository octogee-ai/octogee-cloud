import {
  DuplicateRecordError,
  type GatewayRoot,
  type PlatformStateRepositories,
  type Stored,
} from "@octogee/core/platform-state";
import { homeCheckpointOutstanding } from "@octogee/shared/types/glm";
import { findVmRuntimeForInstance } from "./vm-runtime-observation.js";
import type { ReviewResult } from "./token-review.js";
import {
  effectiveGatewayServiceAccountNameForGateway,
  readGatewayAuthorizationInStore,
  type GatewayAuthorization,
} from "@octogee/core/gateway-live-release";

export type BoundTenant =
  | {
      kind: "gateway";
      gatewayId: string;
      ownerUid?: string;
      saName?: string;
      podName?: string;
      podUid?: string;
      finalHomeCheckpoint?: true;
    }
  | {
      kind: "platform";
      actor: "glm-controller" | "octogee-api" | "artifact-worker" | "cron" | "llm-broker" | "npm-cache-proxy";
    };
type PlatformActor = Extract<BoundTenant, { kind: "platform" }>["actor"];

export type TenantBindingResult =
  | "ok"
  | "ok_platform"
  | "shared_gateway"
  | "ns_mismatch"
  | "unknown_tenant"
  | "malformed_sa"
  | "unknown_sa";

export type SaToTenantResult =
  | {
      attached: true;
      tenant: BoundTenant;
      result: "ok" | "ok_platform";
      retiring?: true;
    }
  | {
      attached: false;
      result: Exclude<
        TenantBindingResult,
        "ok" | "ok_platform"
      >;
    };

export interface ServiceAccountIdentity {
  namespace: string;
  saName: string;
  podUid?: string;
}

const GATEWAY_SA_PREFIX = "octogee-gw-";
const RETIRED_GATEWAY_SA_PREFIX = "octogee-gateway-";
const SHARED_GATEWAY_SA_NAME = "octogee-gateway";
type TenantState = Pick<PlatformStateRepositories, "gateways" | "fleetRegistry">;

function isDnsLabel(value: string): boolean {
  if (value.length < 1 || value.length > 63) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isLower && ch !== "-") return false;
  }
  return true;
}

function gatewayIdFromSaSuffix(suffix: string): string | null {
  if (!isDnsLabel(suffix)) return null;
  return suffix;
}

function platformActorFromSa(saName: string): PlatformActor | null {
  if (saName === "octogee-glm-controller") return "glm-controller";
  if (saName === "octogee-api") return "octogee-api";
  if (saName === "octogee-artifact-worker") return "artifact-worker";
  if (saName === "octogee-cron") return "cron";
  if (saName === "llm-broker") return "llm-broker";
  if (saName === "octogee-npm-cache-proxy") return "npm-cache-proxy";
  return null;
}

function attachGateway(
  gatewayId: string,
  ownerUid: string | null,
  result: "ok",
  finalHomeCheckpoint = false,
  retiring = false,
): SaToTenantResult {
  return {
    attached: true,
    result,
    ...(retiring ? { retiring: true as const } : {}),
    tenant: {
      kind: "gateway",
      gatewayId,
      ...(ownerUid ? { ownerUid } : {}),
      ...(finalHomeCheckpoint ? { finalHomeCheckpoint: true as const } : {}),
    },
  };
}

function gatewayIdentityAdmitted(
  authorization: GatewayAuthorization | null,
  identity: ServiceAccountIdentity,
): authorization is GatewayAuthorization {
  if (!authorization) return false;
  const { gateway } = authorization;
  if (gateway.desiredStatus !== "retired") return true;
  return gateway.retirementClaim?.phase === "claimed" && !!identity.podUid;
}

async function bindGatewaySa(
  store: TenantState,
  identity: ServiceAccountIdentity,
  suffix: string,
  result: "ok",
): Promise<SaToTenantResult> {
  const { saName } = identity;
  const gatewayId = gatewayIdFromSaSuffix(suffix);
  if (!gatewayId) return { attached: false, result: "malformed_sa" };

  const authorization = await readGatewayAuthorizationInStore(store, gatewayId);
  if (!gatewayIdentityAdmitted(authorization, identity)) {
    return { attached: false, result: "unknown_tenant" };
  }
  if (
    effectiveGatewayServiceAccountNameForGateway(authorization.config, gatewayId) !== saName
  ) {
    return { attached: false, result: "unknown_tenant" };
  }
  return attachGateway(
    gatewayId,
    authorization.config.ownerUid,
    result,
    false,
    authorization.gateway.desiredStatus === "retired",
  );
}

async function rootForServiceAccount(store: TenantState, saName: string): Promise<Stored<GatewayRoot> | null> {
  try {
    return await store.gateways.roots.findByServiceAccountName(saName);
  } catch (error) {
    if (error instanceof DuplicateRecordError) return null;
    throw error;
  }
}

async function bindCustomGatewaySa(
  store: TenantState,
  identity: ServiceAccountIdentity,
): Promise<SaToTenantResult> {
  const { saName } = identity;
  const root = await rootForServiceAccount(store, saName);
  if (!root) return { attached: false, result: "unknown_tenant" };
  const authorization = await readGatewayAuthorizationInStore(store, root.gatewayId);
  if (!gatewayIdentityAdmitted(authorization, identity)) {
    return { attached: false, result: "unknown_tenant" };
  }
  if (
    effectiveGatewayServiceAccountNameForGateway(
      authorization.config,
      authorization.gateway.gatewayId,
    ) !== saName
  ) {
    return { attached: false, result: "unknown_tenant" };
  }
  return attachGateway(
    authorization.gateway.gatewayId,
    authorization.config.ownerUid,
    "ok",
    false,
    authorization.gateway.desiredStatus === "retired",
  );
}

export interface ComputeInstanceTenantIdentity {
  instanceId: string;
}

export async function mapComputeInstanceToTenant(
  store: TenantState,
  identity: ComputeInstanceTenantIdentity,
): Promise<SaToTenantResult> {
  if (!identity.instanceId) return { attached: false, result: "malformed_sa" };
  const runtime = await findVmRuntimeForInstance(store, identity.instanceId);
  if (!runtime) return { attached: false, result: "unknown_tenant" };
  const authorization = await readGatewayAuthorizationInStore(store, runtime.gatewayId);
  if (!authorization) return { attached: false, result: "unknown_tenant" };
  if (authorization.gateway.desiredStatus === "retired") {
    if (!homeCheckpointOutstanding(runtime.home)) return { attached: false, result: "unknown_tenant" };
    return attachGateway(runtime.gatewayId, authorization.config.ownerUid, "ok", true);
  }
  return attachGateway(runtime.gatewayId, authorization.config.ownerUid, "ok");
}

export async function mapReviewToTenant(
  store: TenantState,
  review: Extract<ReviewResult, { authenticated: true }>,
  expectedNamespace = process.env.K8S_NAMESPACE ?? "octogee",
): Promise<SaToTenantResult> {
  if (review.computeInstance) {
    if (review.namespace !== expectedNamespace) return { attached: false, result: "ns_mismatch" };
    return mapComputeInstanceToTenant(store, review.computeInstance);
  }
  return mapSaToTenant(
    store,
    {
      namespace: review.namespace,
      saName: review.saName,
      ...(review.podUid ? { podUid: review.podUid } : {}),
    },
    expectedNamespace,
  );
}

export async function mapSaToTenant(
  store: TenantState,
  identity: ServiceAccountIdentity,
  expectedNamespace = process.env.K8S_NAMESPACE ?? "octogee",
): Promise<SaToTenantResult> {
  if (identity.namespace !== expectedNamespace) {
    return { attached: false, result: "ns_mismatch" };
  }

  if (identity.saName === SHARED_GATEWAY_SA_NAME) {
    return { attached: false, result: "shared_gateway" };
  }

  const actor = platformActorFromSa(identity.saName);
  if (actor) {
    return {
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor },
    };
  }

  if (identity.saName.startsWith(GATEWAY_SA_PREFIX)) {
    return bindGatewaySa(
      store,
      identity,
      identity.saName.slice(GATEWAY_SA_PREFIX.length),
      "ok",
    );
  }

  if (identity.saName.startsWith(RETIRED_GATEWAY_SA_PREFIX)) {
    return { attached: false, result: "unknown_sa" };
  }

  if (!isDnsLabel(identity.saName)) return { attached: false, result: "unknown_sa" };
  return bindCustomGatewaySa(store, identity);
}
