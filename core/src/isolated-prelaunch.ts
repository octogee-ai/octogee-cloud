import { builderActivateOperationId } from "./isolated-operation-ids.js";
import { isOperatorIssuedAllocation } from "./operator-isolated-gateway.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
import type { UserActivationLease, PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateRepositories } from "./platform-state/store.js";

type DurableGateway = GatewayDoc & GatewayMutableConfig;

export type PrelaunchAuthorityReader = Pick<PlatformStateRepositories, "users" | "gateways">;

function prelaunchStatusMatches(gatewayId: string, generation: number, lease: UserActivationLease, activationBoot: boolean): boolean {
  return lease.status === "provisioning" && lease.activationOperationId === undefined && lease.activatingAt === undefined ||
    activationBoot && ["provisioning", "activating"].includes(lease.status) &&
    lease.activationOperationId === builderActivateOperationId(gatewayId, generation);
}

function prelaunchLease(gateway: DurableGateway, user: PlatformUserRecord | null, activationBoot = false): UserActivationLease | null {
  const lease = user?.activationLease ?? null;
  const allocation = gateway.allocation;
  if (!user || !accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle }) || !lease || !allocation) return null;
  return [
    gateway.desiredStatus === "running",
    gateway.gatewayClass === "builder",
    allocation.kind === "disposable-builder",
    gateway.ownerUid === allocation.claimedByUid,
    lease.leaseId === allocation.leaseId,
    lease.generation === allocation.generation,
    lease.targetGatewayId === gateway.gatewayId,
    prelaunchStatusMatches(gateway.gatewayId, allocation.generation, lease, activationBoot),
    lease.activeAt === undefined,
    typeof lease.sourceGatewayId === "string",
    lease.sourceGatewayId !== gateway.gatewayId,
    user.gateway?.gatewayId === lease.sourceGatewayId,
    user.slug === gateway.builderSlug,
    lease.builderSlug === gateway.builderSlug,
    Number.isSafeInteger(lease.sourceAssignmentEpoch),
  ].every(Boolean) ? lease : null;
}

interface PrelaunchSource {
  sourceGatewayId: string;
  sourceAssignmentEpoch: number | null;
}

function leasePrelaunchSource(gateway: DurableGateway, user: PlatformUserRecord | null, activationBoot: boolean): PrelaunchSource | null {
  const lease = prelaunchLease(gateway, user, activationBoot);
  return lease ? { sourceGatewayId: lease.sourceGatewayId!, sourceAssignmentEpoch: lease.sourceAssignmentEpoch! } : null;
}

function operatorPrelaunchSource(gateway: DurableGateway, user: PlatformUserRecord | null): PrelaunchSource | null {
  const sourceGatewayId = user?.gateway?.gatewayId;
  if (!user || !accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle }) || !sourceGatewayId) return null;
  return [
    gateway.desiredStatus === "running",
    gateway.ownerUid === gateway.allocation?.claimedByUid,
    sourceGatewayId !== gateway.gatewayId,
    user.slug === gateway.builderSlug,
  ].every(Boolean) ? { sourceGatewayId, sourceAssignmentEpoch: null } : null;
}

function samePrelaunchAllocation(gateway: DurableGateway, expected: DurableGateway): boolean {
  return [
    gateway.ownerUid === expected.ownerUid,
    gateway.builderSlug === expected.builderSlug,
    gateway.allocation?.leaseId === expected.allocation?.leaseId,
    gateway.allocation?.generation === expected.allocation?.generation,
    gateway.latestRelease === expected.latestRelease,
  ].every(Boolean);
}

export async function isolatedPrelaunchReserved(input: {
  reader: PrelaunchAuthorityReader;
  gateway: DurableGateway;
  expectedGateway?: DurableGateway;
  activationBoot?: true;
}): Promise<boolean> {
  const { reader, gateway, expectedGateway } = input;
  if (expectedGateway && !samePrelaunchAllocation(gateway, expectedGateway)) return false;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder" || !gateway.ownerUid) {
    return false;
  }
  const user = await reader.users.records.get(gateway.ownerUid);
  const source = isOperatorIssuedAllocation(gateway.allocation)
    ? operatorPrelaunchSource(gateway, user)
    : leasePrelaunchSource(gateway, user, input.activationBoot === true);
  if (!source) return false;
  const { sourceGatewayId, sourceAssignmentEpoch } = source;
  const [sourceRoot, assigned, targetEmpty] = await Promise.all([
    reader.gateways.roots.get(sourceGatewayId),
    reader.gateways.assignments.get(sourceGatewayId, gateway.ownerUid),
    reader.gateways.assignments.isEmpty(gateway.gatewayId),
  ]);
  if (!assigned || sourceRoot?.gatewayClass !== "shared") return false;
  return [
    assigned.uid === gateway.ownerUid,
    assigned.slug === gateway.builderSlug,
    assigned.gatewayId === sourceGatewayId,
    assigned.state === "serving",
    sourceAssignmentEpoch === null || assigned.epoch === sourceAssignmentEpoch,
    targetEmpty,
  ].every(Boolean);
}

function activationLeaseMatches(gateway: DurableGateway, lease: UserActivationLease | null): lease is UserActivationLease {
  return Boolean(lease && lease.leaseId === gateway.allocation?.leaseId && lease.generation === gateway.allocation?.generation &&
    lease.targetGatewayId === gateway.gatewayId && gateway.allocation?.claimedByUid === gateway.ownerUid && lease.builderSlug === gateway.builderSlug);
}

function activationBootMode(gateway: DurableGateway, lease: UserActivationLease): { mode: "prelaunch" | "normal" | "activating"; migrationId?: string } {
  if (["active", "returning", "failed"].includes(lease.status)) return { mode: "normal" };
  if (lease.status === "activating" || (lease.status === "provisioning" && lease.activationOperationId !== undefined)) {
    if (typeof lease.activationOperationId !== "string" || lease.activationOperationId !== builderActivateOperationId(gateway.gatewayId, gateway.allocation!.generation)) {
      throw new Error("User activation operation is unavailable");
    }
    return { mode: "activating", migrationId: `mig-${lease.activationOperationId}` };
  }
  if (lease.status !== "provisioning" || lease.activatingAt !== undefined || lease.activeAt !== undefined) throw new Error("Isolated prelaunch authority is inconsistent");
  return { mode: "prelaunch" };
}

async function hasServingUserAssignment(reader: PrelaunchAuthorityReader, gateway: DurableGateway, user: PlatformUserRecord): Promise<boolean> {
  if (user.gateway?.gatewayId !== gateway.gatewayId) return false;
  const assigned = await reader.gateways.assignments.get(gateway.gatewayId, user.uid);
  return assigned?.uid === user.uid && assigned.state === "serving";
}

export async function isolatedBootMode(input: {
  reader: PrelaunchAuthorityReader; gateway: DurableGateway;
}): Promise<{ mode: "prelaunch" | "normal" | "activating"; migrationId?: string }> {
  const { gateway, reader } = input;
  if (gateway.gatewayClass !== "builder" || gateway.allocation?.kind !== "disposable-builder") return { mode: "normal" };
  if (!gateway.ownerUid) throw new Error("Isolated prelaunch owner is unavailable");
  const user = await reader.users.records.get(gateway.ownerUid);
  if (!user) throw new Error("Isolated prelaunch owner is unavailable");
  if (await hasServingUserAssignment(reader, gateway, user)) return { mode: "normal" };
  if (isOperatorIssuedAllocation(gateway.allocation)) {
    if (await isolatedPrelaunchReserved(input)) return { mode: "prelaunch" };
    if (!(await reader.gateways.assignments.isEmpty(gateway.gatewayId))) return { mode: "normal" };
    throw new Error("Operator isolated gateway prelaunch authority is unavailable");
  }
  const lease = user.activationLease;
  if (!activationLeaseMatches(gateway, lease)) {
    throw new Error("User activation authority is inconsistent");
  }
  const boot = activationBootMode(gateway, lease);
  if (boot.mode !== "normal" && await isolatedPrelaunchReserved({ ...input, activationBoot: true })) return { mode: "prelaunch" };
  if (boot.mode === "prelaunch") throw new Error("Isolated prelaunch authority is inconsistent");
  return boot;
}
