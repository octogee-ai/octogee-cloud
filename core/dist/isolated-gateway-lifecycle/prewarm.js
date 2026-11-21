import { isDeepStrictEqual } from "node:util";
import { releasePayloadHash, isReleasePayload } from "@octogee/shared/types/gateway-releases";
import { isGatewayVmBootRecoverySample } from "@octogee/shared/types/glm";
import { assertGatewayRuntimeMutationUnfencedInStore, isolatedRuntimeMutationFenced } from "../gateway-retirement-claim.js";
import { readGatewayArtifactInStore } from "../gateway-live-release.js";
import { readSharedGatewayPoolConfigInStore } from "../shared-gateway-pool-read.js";
import { userAllowsInteractiveAccess } from "./lease.js";
export const PARKED_PREWARM_KIND = "prewarm-gateway";
export const ACTIVE_PARKED_PREWARM_STATUSES = ["pending", "running"];
export function parkedPrewarmInput(operation) {
    const { uid, gatewayId, generation, sourceSha, bootImageId, payload } = operation.input;
    if (typeof uid !== "string" || !uid || typeof gatewayId !== "string" || !gatewayId ||
        typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 ||
        typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha) ||
        typeof bootImageId !== "string" || !/^[1-9]\d{0,19}$/.test(bootImageId) ||
        !isReleasePayload(payload)) {
        throw new Error("Invalid parked computer prewarm operation input");
    }
    return { uid, gatewayId, generation, sourceSha, bootImageId, payload };
}
export async function readActiveParkedPrewarm(state, uid) {
    const operations = await state.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ACTIVE_PARKED_PREWARM_STATUSES });
    return operations.find((operation) => parkedPrewarmPlacementHold(operation) !== undefined) ?? null;
}
const BOOTING = "booting";
const HANDOFF = "handoff";
const REPAIRING = "repairing";
const REPAIR_PARKING = "repair-parking";
const DEMAND_WON = "demand-won";
const PREWARM_CLAIM_STATES = [BOOTING, HANDOFF, REPAIRING, REPAIR_PARKING];
function isPrewarmClaimActive(state) {
    return PREWARM_CLAIM_STATES.some((phase) => phase === state);
}
export function parkedPrewarmPlacementHold(operation) {
    const phase = operation.output?.prewarmState;
    if (operation.kind !== PARKED_PREWARM_KIND ||
        !ACTIVE_PARKED_PREWARM_STATUSES.some(status => status === operation.status) ||
        !isPrewarmClaimActive(phase))
        return undefined;
    return phase === HANDOFF ? HANDOFF : "blocking";
}
export function activeParkedPrewarmGatewayIds(operations) {
    return new Set(operations.flatMap(operation => operation.gatewayId && parkedPrewarmPlacementHold(operation) !== undefined ? [operation.gatewayId] : []));
}
function prewarmClaim(operation) {
    const { release, previousRelease, previousInstanceId, sourceGatewayId, sourceAssignmentEpoch } = operation.output ?? {};
    if (typeof release !== "number" || typeof previousRelease !== "number" || typeof previousInstanceId !== "string" ||
        typeof sourceGatewayId !== "string" || typeof sourceAssignmentEpoch !== "number") {
        throw new Error("Parked computer prewarm claim is missing its original VM or release");
    }
    return { release, previousRelease, previousInstanceId, sourceGatewayId, sourceAssignmentEpoch };
}
function assertPrewarmWorker(operation, current) {
    if (current?.kind !== PARKED_PREWARM_KIND || current.status !== "running" || current.startedAt !== operation.startedAt) {
        throw new Error("Parked computer prewarm worker claim changed");
    }
}
function hasCustomerDemand(status) {
    return status !== undefined && status !== "parked" && status !== "failed";
}
function parkedRootEligible(root, uid, generation) {
    return root?.desiredStatus === "paused" && root.gatewayClass === "isolated" &&
        root.ownerUid === uid && root.allocation?.claimedByUid === uid && root.allocation.generation === generation &&
        root.allocation.kind === "disposable-builder" && root.liveRelease !== null && root.liveRelease === root.desiredRelease;
}
function eligibleSharedSource(owner, sharedGatewayIds) {
    const shared = owner?.gateway?.gatewayId;
    return owner && shared && sharedGatewayIds.includes(shared) &&
        userAllowsInteractiveAccess(owner) && !isolatedRuntimeMutationFenced(owner) ? shared : null;
}
function parkedInstanceId(runtime, sourceVm) {
    const vm = runtime?.vm;
    if (runtime?.runtime !== "gce-vm" || vm?.status !== "SUSPENDED" ||
        (sourceVm && sourceVm.instanceId !== vm.instanceId))
        return null;
    return vm.instanceId;
}
function conflictingPrewarmOwnerOperation(conflicts, id) {
    return conflicts.some((entry) => entry.id !== id &&
        (entry.kind !== PARKED_PREWARM_KIND || isPrewarmClaimActive(entry.output?.prewarmState)));
}
function existingOrDemandOperation(current, owner) {
    const phase = current.output?.prewarmState;
    if (phase === "parked" || isPrewarmClaimActive(phase))
        return { state: phase, claim: prewarmClaim(current) };
    if (phase === DEMAND_WON || hasCustomerDemand(owner?.activationLease?.status))
        return { state: DEMAND_WON };
    return null;
}
async function writePrewarmStart(tx, input) {
    const { operation, request, root, claim, now, sourceVm } = input;
    const { gatewayId, payload } = request;
    const repairing = sourceVm?.needsRepair === true;
    if (claim.release !== root.liveRelease) {
        await tx.gateways.releases.append({
            gatewayId, expectedLatestRelease: root.latestRelease, createdAt: now, createdBy: operation.id,
            sourceRelease: root.liveRelease, note: "Parked computer prewarm", payload,
            payloadHash: releasePayloadHash(payload), activate: !repairing, updatedBy: operation.id,
        });
    }
    await tx.gateways.roots.patch(gatewayId, { desiredStatus: "running", updatedAt: now, updatedBy: operation.id });
    const state = repairing ? REPAIRING : BOOTING;
    await tx.journal.operations.patch(operation.id, { output: {
            prewarmState: state, ...claim, ...(repairing ? { repairStartedAt: now, previousBootImageId: sourceVm.bootImageId } : {}),
        } });
    return { state, claim };
}
export async function startParkedGatewayPrewarm(store, operation, now, sourceVm) {
    const request = parkedPrewarmInput(operation);
    const { uid, gatewayId, generation, payload } = request;
    return store.transaction({ label: "isolated-gateway.prewarm-start" }, async (tx) => {
        const [current, root, runtime, owner, pool, empty, conflicts] = await Promise.all([
            tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId),
            tx.fleetRegistry.get(gatewayId), tx.users.records.get(uid), readSharedGatewayPoolConfigInStore(tx),
            tx.gateways.assignments.isEmpty(gatewayId), tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
        ]);
        assertPrewarmWorker(operation, current);
        const result = existingOrDemandOperation(current, owner);
        if (result)
            return result;
        const sharedId = eligibleSharedSource(owner, pool?.sharedGatewayIds ?? []);
        const instanceId = parkedInstanceId(runtime, sourceVm);
        if (!sharedId || !instanceId || !empty || !parkedRootEligible(root, uid, generation) ||
            conflictingPrewarmOwnerOperation(conflicts, operation.id))
            return { state: "ineligible" };
        const [assignment, release] = await Promise.all([
            tx.gateways.assignments.get(sharedId, uid), tx.gateways.releases.get(gatewayId, root.liveRelease),
            assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId),
        ]);
        if (assignment?.state !== "serving" || assignment.slug !== root.builderSlug || !release)
            return { state: "ineligible" };
        const sameRelease = release.payloadHash === releasePayloadHash(payload);
        const claim = {
            release: sameRelease ? root.liveRelease : root.latestRelease + 1,
            previousRelease: root.liveRelease, previousInstanceId: instanceId,
            sourceGatewayId: sharedId, sourceAssignmentEpoch: assignment.epoch,
        };
        return writePrewarmStart(tx, { operation, request, root, claim, now, sourceVm });
    });
}
export function isFreshParkedPrewarmRecovery(value, instanceId, notBefore) {
    if (!isGatewayVmBootRecoverySample(value) || typeof notBefore !== "number")
        return false;
    const recovery = value;
    return recovery.ready && recovery.retainedPoints <= 1 && recovery.freeBytes >= 2 * 1024 ** 3 &&
        recovery.instanceId === instanceId && typeof recovery.observedAt === "number" && recovery.observedAt >= notBefore &&
        (recovery.retainedPoints === 0) === (recovery.currentPointId === null);
}
function finishAlreadyResolved(operation, root, owner, request, mode) {
    const phase = operation.output?.prewarmState;
    if (phase === "parked" || phase === DEMAND_WON)
        return phase;
    if (phase !== HANDOFF)
        return null;
    if (mode === "ready")
        return HANDOFF;
    return root?.ownerUid === request.uid && root.allocation?.generation !== request.generation &&
        owner?.activationLease?.targetGatewayId === request.gatewayId ? DEMAND_WON : null;
}
function assertOwnedPrewarmRoot(root, request, expected) {
    if (!root || root.desiredStatus !== expected.status || root.ownerUid !== request.uid ||
        root.allocation?.claimedByUid !== request.uid || root.allocation.generation !== request.generation ||
        root.desiredRelease !== expected.release) {
        throw new Error("Parked computer prewarm no longer owns the unassigned gateway");
    }
}
function assertOriginalVmRecovery(operation, originalInstanceId, runtime) {
    if (operation.output?.prewarmState !== REPAIRING || runtime?.vm?.instanceId !== originalInstanceId ||
        runtime.vm.status !== "RUNNING" || !isFreshParkedPrewarmRecovery(runtime.vmBootRecovery, originalInstanceId, operation.output.repairStartedAt)) {
        throw new Error("Original VM has not published fresh healthy boot recovery");
    }
}
async function sameDemandArtifact(tx, root, owner, liveRelease) {
    const lease = owner?.activationLease;
    const requestedSource = lease?.sourceGatewayId;
    if (lease?.status !== "requested" || !requestedSource ||
        owner?.gateway?.gatewayId !== requestedSource || lease.entitlementTier !== root.sizingProfile)
        return false;
    const source = await tx.gateways.roots.get(requestedSource);
    if (source?.gatewayClass !== "shared" || source.liveRelease !== source.desiredRelease)
        return false;
    const [sourceArtifact, destinationArtifact] = await Promise.all([
        readGatewayArtifactInStore(tx, requestedSource, source.liveRelease),
        readGatewayArtifactInStore(tx, root.gatewayId, liveRelease),
    ]);
    return destinationArtifact !== null && isDeepStrictEqual(sourceArtifact, destinationArtifact);
}
function finishedParkPhase(owner, mode) {
    if (hasCustomerDemand(owner?.activationLease?.status))
        return DEMAND_WON;
    return mode === "repaired" ? REPAIR_PARKING : "parked";
}
function prewarmFinishWindow(claim, phase) {
    const recovering = phase === REPAIRING || phase === REPAIR_PARKING;
    return {
        status: phase === REPAIR_PARKING ? "paused" : "running",
        release: recovering ? claim.previousRelease : claim.release,
    };
}
async function writePrewarmPark(tx, input) {
    const { current, root, owner, runtime, claim, now, mode } = input;
    const state = finishedParkPhase(owner, mode);
    await tx.gateways.roots.patch(root.gatewayId, {
        desiredStatus: "paused",
        ...(mode === "rollback" && root.liveRelease !== claim.release ? { desiredRelease: claim.previousRelease } : {}),
        updatedAt: now, updatedBy: current.id,
    }, { revision: root.revision });
    await tx.journal.operations.patch(current.id, { output: {
            ...current.output, ...claim, prewarmState: state,
            ...(state === REPAIR_PARKING ? { repairedBootRecovery: runtime?.vmBootRecovery } : {}),
        } });
    return state;
}
export async function finishParkedGatewayPrewarm(store, operation, now, mode) {
    const request = parkedPrewarmInput(operation);
    const { uid, gatewayId } = request;
    return store.transaction({ label: "isolated-gateway.prewarm-finish" }, async (tx) => {
        const [current, root, owner, empty, runtime] = await Promise.all([
            tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.users.records.get(uid),
            tx.gateways.assignments.isEmpty(gatewayId), tx.fleetRegistry.get(gatewayId),
        ]);
        assertPrewarmWorker(operation, current);
        const resolved = finishAlreadyResolved(current, root, owner, request, mode);
        if (resolved)
            return resolved;
        const claim = prewarmClaim(current);
        const window = prewarmFinishWindow(claim, current.output?.prewarmState);
        const liveRelease = window.release;
        assertOwnedPrewarmRoot(root, request, window);
        if (!empty || owner?.gateway?.gatewayId === gatewayId)
            throw new Error("Parked computer prewarm no longer owns the unassigned gateway");
        if (mode !== "rollback" && root.liveRelease !== liveRelease)
            throw new Error("Prewarmed release is not live");
        if (mode === "repaired")
            assertOriginalVmRecovery(current, claim.previousInstanceId, runtime);
        if (mode !== "rollback" && await sameDemandArtifact(tx, root, owner, liveRelease)) {
            await tx.journal.operations.patch(operation.id, { output: { ...claim, prewarmState: HANDOFF, release: liveRelease } });
            return HANDOFF;
        }
        return writePrewarmPark(tx, { current, root, owner, runtime, claim, now, mode });
    });
}
export async function bootRepairedParkedGateway(store, operation, now) {
    const request = parkedPrewarmInput(operation);
    const { uid, gatewayId } = request;
    return store.transaction({ label: "isolated-gateway.prewarm-repaired-boot" }, async (tx) => {
        const [current, root, runtime, user, empty] = await Promise.all([
            tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
            tx.users.records.get(uid), tx.gateways.assignments.isEmpty(gatewayId),
        ]);
        assertPrewarmWorker(operation, current);
        if (current.output?.prewarmState !== REPAIR_PARKING)
            throw new Error("Original VM recovery park claim changed");
        const claim = prewarmClaim(current);
        if (hasCustomerDemand(user?.activationLease?.status)) {
            await tx.journal.operations.patch(operation.id, { output: { ...current.output, prewarmState: DEMAND_WON } });
            return DEMAND_WON;
        }
        assertOwnedPrewarmRoot(root, request, { status: "paused", release: claim.previousRelease });
        if (root.liveRelease !== claim.previousRelease || parkedInstanceId(runtime, undefined) !== claim.previousInstanceId ||
            !empty || !user || isolatedRuntimeMutationFenced(user) || user.gateway?.gatewayId === gatewayId) {
            throw new Error("Claimed original VM was not safely parked after recovery");
        }
        await assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId);
        await tx.gateways.roots.patch(gatewayId, {
            desiredStatus: "running", desiredRelease: claim.release, updatedAt: now, updatedBy: operation.id,
        }, { revision: root.revision });
        await tx.journal.operations.patch(operation.id, { output: { ...current.output, prewarmState: BOOTING } });
        return BOOTING;
    });
}
