import { podBelongsToGateway } from "../gateway-live-release.js";
export function sameEphemeralWriter(writer, pod) {
    return writer?.podUid === pod.podUid && writer.podName === pod.podName;
}
export function ephemeralSourceMatches(gateway, ownerUid) {
    return gateway?.gatewayClass === "isolated" && gateway.desiredStatus === "running" &&
        gateway.ownerUid === ownerUid && gateway.allocation?.claimedByUid === ownerUid &&
        gateway.allocation.ephemeralHomeGiB !== undefined && gateway.retirementClaim == null && !gateway.runtimeRestartFence;
}
export function excludedDisklessWriter(root, owner) {
    if (!ephemeralSourceMatches(root, owner.uid) || !root.allocation || root.builderSlug !== owner.slug)
        return false;
    return root.allocation.leaseId === owner.leaseId && root.allocation.generation === owner.generation &&
        root.ephemeralWriter?.exclusion !== undefined;
}
async function mayReplaceStartupWriter(tx, root, ownerUid) {
    const { gatewayId, allocation } = root;
    const [user, assignment] = await Promise.all([tx.users.records.get(ownerUid), tx.gateways.assignments.get(gatewayId, ownerUid)]);
    if (!user || user.gateway?.gatewayId === gatewayId || assignment || user.fences.restoreFence || user.fences.sourceTransferFence)
        return false;
    const lease = user.activationLease;
    return lease?.status === "provisioning" && lease.targetGatewayId === gatewayId &&
        lease.leaseId === allocation?.leaseId && lease.generation === allocation?.generation;
}
export async function claimEphemeralWriter(input) {
    const { store, gatewayId, ownerUid, pod } = input;
    if (!pod.podUid || !podBelongsToGateway(gatewayId, pod.podName))
        return false;
    return store.transaction({ label: "ephemeral-recovery.claim-writer" }, async (tx) => {
        const root = await tx.gateways.roots.get(gatewayId);
        if (!ephemeralSourceMatches(root, ownerUid))
            return false;
        const previous = root.ephemeralWriter;
        if (previous) {
            if (previous.exclusion === undefined)
                return sameEphemeralWriter(previous, pod);
            if (sameEphemeralWriter(previous, pod) || !await mayReplaceStartupWriter(tx, root, ownerUid))
                return false;
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
