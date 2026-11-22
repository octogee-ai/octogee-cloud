import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { isDisposableHomeCheckpoint } from "@octogee/shared/types/glm";
import { builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { isolatedSizingTier } from "@octogee/shared/types/sizing-profile";
import { assertGatewayRuntimeMutationUnfencedInStore, GatewayRetirementConflictError, isolatedRuntimeMutationFenced, } from "../gateway-retirement-claim.js";
import { withCurrentSizingKey } from "../sizing-key.js";
import { ISOLATED_GATEWAY_ALLOCATION_KIND, PLACEMENT_AUTOMATION_ACTOR, } from "./inputs.js";
import { userAllowsInteractiveAccess } from "./lease.js";
import { readActiveParkedPrewarm } from "./prewarm.js";
function numericIdentity(value) {
    return typeof value === "string" && /^[1-9]\d*$/u.test(value);
}
function retainedHomeMatches(owner, vm) {
    const { homeArchive, homeCheckpoint, homeDisk, computer } = owner.home;
    const parkedComputerMatches = computer === undefined || (computer.instanceId === vm.instanceId &&
        computer.instanceName === vm.instanceName && computer.zone === vm.zone);
    const diskMatches = numericIdentity(homeDisk?.id) && homeDisk?.zone === vm.zone &&
        typeof homeDisk.projectId === "string" && typeof homeDisk.name === "string" &&
        homeDisk.source === `projects/${homeDisk.projectId}/zones/${vm.zone}/disks/${homeDisk.name}`;
    return [homeArchive === undefined || homeArchive.phase === "restored",
        numericIdentity(vm.instanceId), isDisposableHomeCheckpoint(homeCheckpoint), homeCheckpoint?.instanceId === vm.instanceId,
        parkedComputerMatches, diskMatches].every(Boolean);
}
function reparkRootMatches(root, request) {
    const allocation = root.allocation;
    return [
        root.gatewayClass === "isolated", root.ownerUid === request.uid, root.builderSlug === request.builderSlug,
        root.desiredStatus === "running" || root.desiredStatus === "paused", root.retirementClaim == null,
        root.liveRelease !== null, root.liveRelease === root.desiredRelease,
        allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND, allocation?.claimedByUid === request.uid,
        allocation?.generation === request.generation,
    ].every(Boolean);
}
function emptyReparkRuntime(root, runtime, now) {
    const heartbeat = runtime.heartbeat;
    if (heartbeat.mountedCustomers.length !== 0)
        return false;
    const at = heartbeat.lastHeartbeatAt;
    return root.desiredStatus === "paused" || (runtime.vm?.status === "RUNNING" && heartbeat.status === "ready" &&
        at !== null && at <= now && now - at <= GATEWAY_UNREACHABLE_AFTER_MS);
}
async function successorHasParkedReturn(tx, request, lease, previousLeaseId, sharedGatewayId) {
    if (lease.status !== "requested" || lease.generation !== request.generation + 1 ||
        lease.leaseId === previousLeaseId || lease.targetGatewayId != null || lease.sourceGatewayId !== sharedGatewayId)
        return false;
    const returnId = builderReturnOperationId(request.gatewayId, request.generation);
    const [receipt, operation] = await Promise.all([
        tx.users.placementReceipts.get(request.uid, previousLeaseId, request.generation, "returned"),
        tx.journal.operations.get(returnId),
    ]);
    if (!receipt || !operation)
        return false;
    return [
        receipt.gatewayId === request.gatewayId, receipt.builderSlug === request.builderSlug, receipt.sharedGatewayId === sharedGatewayId,
        receipt.operationId === returnId, receipt.retirementOperationId === null, receipt.operatorTerminated === false,
        operation.kind === "migrate-user", operation.status === "succeeded", operation.input.uid === request.uid,
        operation.input.userSlug === request.builderSlug, operation.input.fromGatewayId === request.gatewayId,
        operation.input.toGatewayId === sharedGatewayId,
    ].every(Boolean);
}
function exactParkedLease(lease, request, id) {
    return lease.status === "parked" && lease.leaseId === id && lease.generation === request.generation &&
        lease.targetGatewayId === request.gatewayId;
}
async function hasExclusiveReparkCustody(tx, request, lease, oldLeaseId, sourceId) {
    const { uid, gatewayId, builderSlug } = request;
    const [source, assignment, targetEmpty, active, prewarm] = await Promise.all([
        tx.gateways.roots.get(sourceId), tx.gateways.assignments.get(sourceId, uid), tx.gateways.assignments.isEmpty(gatewayId),
        tx.journal.operations.listByStatus(["pending", "running"]), readActiveParkedPrewarm(tx, uid),
    ]);
    if (!assignment || ![source?.gatewayClass === "shared", ["running", "draining"].includes(source?.desiredStatus ?? ""),
        assignment.state === "serving", assignment.slug === builderSlug, targetEmpty, prewarm === null].every(Boolean))
        return false;
    if (active.some(op => [op.gatewayId, op.input.gatewayId, op.input.fromGatewayId, op.input.toGatewayId].includes(gatewayId) ||
        op.input.uid === uid))
        return false;
    if (!exactParkedLease(lease, request, oldLeaseId) && (lease.sourceAssignmentEpoch !== assignment.epoch ||
        !await successorHasParkedReturn(tx, request, lease, oldLeaseId, sourceId)))
        return false;
    try {
        await assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId);
        return true;
    }
    catch (error) {
        if (error instanceof GatewayRetirementConflictError)
            return false;
        throw error;
    }
}
function reparkSizingMatches(root, lease, sizingKey, profile) {
    return profile?.isolation === "isolated" && profile.computer.runtime === "gce-vm" &&
        root.sizingTier === isolatedSizingTier(profile) && lease.sizingTier === root.sizingTier &&
        root.sizingProfile === sizingKey && lease.entitlementTier === sizingKey;
}
export async function retainsEntitledParkedCohort(tx, request, current) {
    const [owner, root] = await Promise.all([tx.users.records.get(request.uid), tx.gateways.roots.get(request.gatewayId)]);
    current.assertCurrent(owner);
    const lease = owner?.activationLease;
    const source = owner?.gateway?.gatewayId;
    if (!owner || !root?.allocation || !lease || !source)
        return false;
    if (![source !== request.gatewayId, owner.slug === request.builderSlug, lease.builderSlug === request.builderSlug,
        userAllowsInteractiveAccess(owner), reparkSizingMatches(root, lease, current.sizingKey, current.profile)].every(Boolean))
        return false;
    return exactParkedLease(lease, request, root.allocation.leaseId) ||
        successorHasParkedReturn(tx, request, lease, root.allocation.leaseId, source);
}
export async function reparkOwnedGateway(deps, request, mode = "apply") {
    const { uid, gatewayId, builderSlug } = request;
    return withCurrentSizingKey({ ...deps, uid, now: deps.now() }, ({ sizingKey, profile, assertCurrent }) => deps.store.transaction({ label: "disposable-gateway.repark", readOnly: mode === "plan" }, async (tx) => {
        await deps.requireOwner(tx);
        const [owner, root, runtime] = await Promise.all([
            tx.users.records.get(uid), tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
        ]);
        assertCurrent(owner);
        if (!owner || !root || !runtime || !reparkRootMatches(root, request))
            return false;
        const { activationLease: lease } = owner;
        const sourceId = owner.gateway?.gatewayId;
        const vm = runtime.vm;
        if (!lease || !sourceId || !vm || !root.allocation || ![
            owner.slug === builderSlug, lease.builderSlug === builderSlug, sourceId !== gatewayId,
            userAllowsInteractiveAccess(owner), !isolatedRuntimeMutationFenced(owner),
            reparkSizingMatches(root, lease, sizingKey, profile), runtime.runtime === "gce-vm", retainedHomeMatches(owner, vm),
        ].every(Boolean))
            return false;
        const now = deps.now();
        if (!emptyReparkRuntime(root, runtime, now) || !await hasExclusiveReparkCustody(tx, request, lease, root.allocation.leaseId, sourceId)) {
            return false;
        }
        if (mode === "apply" && root.desiredStatus === "running") {
            await tx.gateways.roots.patch(gatewayId, { desiredStatus: "paused", updatedAt: now, updatedBy: PLACEMENT_AUTOMATION_ACTOR }, { revision: root.revision });
        }
        return true;
    }));
}
