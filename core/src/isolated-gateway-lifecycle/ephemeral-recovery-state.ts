import { podBelongsToGateway } from "../gateway-live-release.js";
import { builderActivateOperationId, DISKLESS_ACTIVATION_WRITER_EXCLUDED } from "@octogee/shared/types/isolated-operation-ids";
import type { EphemeralGatewayWriter, GatewayRoot, OperationRecord, PlatformStateStore, PlatformStateTransaction } from "../platform-state/index.js";

export function sameEphemeralWriter(writer: EphemeralGatewayWriter | undefined, pod: EphemeralGatewayWriter): boolean {
  return writer?.podUid === pod.podUid && writer.podName === pod.podName;
}

export function ephemeralSourceMatches(gateway: GatewayRoot | null, ownerUid: string): gateway is GatewayRoot {
  return gateway?.gatewayClass === "isolated" && gateway.desiredStatus === "running" &&
    gateway.ownerUid === ownerUid && gateway.allocation?.claimedByUid === ownerUid &&
    gateway.allocation.ephemeralHomeGiB !== undefined && gateway.retirementClaim == null && !gateway.runtimeRestartFence;
}

export function excludedDisklessWriter(
  root: GatewayRoot | null,
  owner: { uid: string; slug: string; leaseId: string; generation: number },
): boolean {
  if (!ephemeralSourceMatches(root, owner.uid) || !root.allocation || root.builderSlug !== owner.slug) return false;
  return root.allocation.leaseId === owner.leaseId && root.allocation.generation === owner.generation &&
    root.ephemeralWriter?.exclusion !== undefined;
}

export async function excludedDisklessActivation(
  tx: PlatformStateTransaction,
  input: { uid: string; slug: string; gatewayId: string; claim?: { operationId: string; startedAt: number } },
): Promise<boolean> {
  const { uid, slug, gatewayId, claim } = input;
  const [user, root, assignment] = await Promise.all([
    tx.users.records.get(uid), tx.gateways.roots.get(gatewayId), tx.gateways.assignments.get(gatewayId, uid),
  ]);
  const lease = user?.activationLease;
  if (!lease || lease.sourceAssignmentEpoch === undefined) return false;
  if (![
    lease.status === "activating", lease.targetGatewayId === gatewayId, user?.slug === slug,
    user?.gateway?.gatewayId === gatewayId, assignment?.state === "serving", assignment?.slug === slug,
    assignment?.epoch === lease.sourceAssignmentEpoch + 1,
    excludedDisklessWriter(root, { uid, slug, leaseId: lease.leaseId, generation: lease.generation }),
  ].every(Boolean)) return false;
  const operationId = builderActivateOperationId(gatewayId, lease.generation);
  if (claim && claim.operationId !== operationId) return false;
  const operation = await tx.journal.operations.get(operationId);
  return matchesInterruptedActivation(operation, { uid, slug, gatewayId, fromGatewayId: lease.sourceGatewayId, claim });
}

function matchesInterruptedActivation(
  operation: OperationRecord | null,
  input: { uid: string; slug: string; gatewayId: string; fromGatewayId: string | undefined; claim?: { startedAt: number } },
): boolean {
  if (!operation) return false;
  const { uid, slug, gatewayId, fromGatewayId, claim } = input;
  const matches = [
    operation.kind === "migrate-user", operation.origin === "automatic", operation.cutoverCommittedAt !== undefined,
    operation.input.source === "builder-activation-lease", operation.input.uid === uid, operation.input.userSlug === slug,
    operation.input.toGatewayId === gatewayId, operation.input.fromGatewayId === fromGatewayId,
  ].every(Boolean);
  return matches && (claim
    ? operation.status === "running" && operation.startedAt === claim.startedAt
    : operation.status === "failed" && operation.error === DISKLESS_ACTIVATION_WRITER_EXCLUDED);
}

async function mayReplaceStartupWriter(tx: PlatformStateTransaction, root: GatewayRoot, ownerUid: string): Promise<boolean> {
  const { gatewayId, allocation } = root;
  const [user, assignment] = await Promise.all([tx.users.records.get(ownerUid), tx.gateways.assignments.get(gatewayId, ownerUid)]);
  if (!user || user.gateway?.gatewayId === gatewayId || assignment || user.fences.restoreFence || user.fences.sourceTransferFence) return false;
  const lease = user.activationLease;
  return lease?.status === "provisioning" && lease.targetGatewayId === gatewayId &&
    lease.leaseId === allocation?.leaseId && lease.generation === allocation?.generation;
}

export async function claimEphemeralWriter(input: {
  store: PlatformStateStore;
  gatewayId: string;
  ownerUid: string;
  pod: EphemeralGatewayWriter;
}): Promise<boolean> {
  const { store, gatewayId, ownerUid, pod } = input;
  if (!pod.podUid || !podBelongsToGateway(gatewayId, pod.podName)) return false;
  return store.transaction({ label: "ephemeral-recovery.claim-writer" }, async tx => {
    const root = await tx.gateways.roots.get(gatewayId);
    if (!ephemeralSourceMatches(root, ownerUid)) return false;
    const previous = root.ephemeralWriter;
    if (previous) {
      if (previous.exclusion === undefined) return sameEphemeralWriter(previous, pod);
      if (sameEphemeralWriter(previous, pod) || !await mayReplaceStartupWriter(tx, root, ownerUid)) return false;
    }
    const runtime = await tx.fleetRegistry.get(gatewayId);
    const placement = runtime?.kubernetes?.pods?.find(placement => placement.uid === pod.podUid && placement.name === pod.podName);
    const node = placement?.providerId && placement.instanceId
      ? { providerId: placement.providerId, instanceId: placement.instanceId }
      : undefined;
    const writer = { podUid: pod.podUid, podName: pod.podName, ...(node ? { node } : {}) };
    await tx.gateways.roots.patch(gatewayId, { ephemeralWriter: writer }, { revision: root.revision });
    return true;
  });
}
