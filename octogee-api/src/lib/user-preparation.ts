import type { FleetRegistryRecord, PlatformStateRepositories } from "@octogee/core/platform-state";
import { gatewayVmPodName, resolveGatewayRuntime } from "@octogee/shared/types/glm";
import { configuredUserCredentialBootstrapAllowed } from "@octogee/core/gateway-live-release";
import { migrationCancellationDeferred } from "@octogee/core/fleet-state";
import type { BoundTenant } from "./sa-to-tenant.js";

function readPath(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export async function configuredUserPreparationAllowed(
  store: PlatformStateRepositories,
  bound: Extract<BoundTenant, { kind: "gateway" }>,
  slug: string,
  ownerUid: string,
): Promise<boolean> {
  if (bound.ownerUid !== ownerUid || !bound.podUid) return false;
  const gateway = await store.gateways.roots.get(bound.gatewayId);
  if (!configuredUserCredentialBootstrapAllowed(gateway ?? undefined, {
    gatewayId: bound.gatewayId, podName: bound.podName, slug, uid: ownerUid,
  })) return false;
  const [user, runtime, operations] = await Promise.all([
    store.users.records.get(ownerUid),
    store.fleetRegistry.get(bound.gatewayId),
    store.journal.operations.listForUid(ownerUid, { kind: "migrate-user", statuses: ["running"] }),
  ]);
  const sourceGatewayId = user?.gateway?.gatewayId;
  if (!sourceGatewayId || sourceGatewayId === bound.gatewayId || user.slug !== slug) return false;
  if (!runtime || !preparationRuntimeMatches(runtime, bound, slug, ownerUid)) return false;
  const matching = operations.filter((operation) => preparationOperationMatches(operation as unknown as Record<string, unknown>, operation.id, { ownerUid, sourceGatewayId, targetGatewayId: bound.gatewayId, slug }));
  return matching.length === 1;
}

function preparationRuntimeMatches(
  runtime: FleetRegistryRecord,
  bound: Extract<BoundTenant, { kind: "gateway" }>,
  slug: string,
  ownerUid: string,
): boolean {
  const podUid = bound.podUid;
  if (!podUid) return false;
  if (resolveGatewayRuntime(runtime.runtime) === "gce-vm") {
    return /^\d+$/.test(podUid) &&
      readPath(runtime, "vm.instanceId") === bound.podUid &&
      readPath(runtime, "vmInstance.ownerUid") === ownerUid &&
      readPath(runtime, "vmInstance.builderSlug") === slug &&
      bound.podName === gatewayVmPodName(bound.gatewayId, podUid);
  }
  const pods = readPath(runtime, "kubernetes.pods");
  return Array.isArray(pods) && pods.some((pod) => pod?.uid === bound.podUid && pod?.name === bound.podName);
}

function preparationOperationMatches(
  operation: Record<string, unknown>,
  operationId: string,
  scope: { ownerUid: string; sourceGatewayId: string; targetGatewayId: string; slug: string },
): boolean {
  const { ownerUid, sourceGatewayId, targetGatewayId, slug } = scope;
  const input = operation.input as Record<string, unknown> | undefined;
  return operation.kind === "migrate-user" && operation.status === "running" &&
    preparationCancellationDeferred(operation, operationId, slug) && !operation.cutoverCommittedAt && input?.uid === ownerUid &&
    input.fromGatewayId === sourceGatewayId && input.toGatewayId === targetGatewayId;
}


function preparationCancellationDeferred(operation: Record<string, unknown>, operationId: string, slug: string): boolean {
  if (operation.cancellationRequestedAt === undefined) return true;
  if (!Number.isSafeInteger(operation.startedAt) || Number(operation.startedAt) <= 0 ||
      !migrationCancellationDeferred(operation, operationId)) return false;
  const state = operation.userMigrationV2 as Record<string, unknown> | undefined;
  if (state) {
    return state.slug === slug && state.migrationId === `mig-${operationId}` &&
      ["sourceQuiesced", "finalSynced", "targetVerified"].includes(String(state.phase)) && state.cutoverAt === undefined &&
      Number.isSafeInteger(state.sourceEpoch) && Number(state.sourceEpoch) >= 0;
  }
  return (operation.schedulerHandoff as { slug?: unknown } | undefined)?.slug === slug;
}
