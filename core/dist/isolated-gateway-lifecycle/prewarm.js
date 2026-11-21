import { isDeepStrictEqual } from "node:util";
import { releasePayloadHash, isReleasePayload } from "@octogee/shared/types/gateway-releases";
import { assertGatewayRuntimeMutationUnfencedInStore, isolatedRuntimeMutationFenced } from "../gateway-retirement-claim.js";
import { gatewayArtifactFromReleasePayload, readGatewayArtifactInStore } from "../gateway-live-release.js";
import { readSharedGatewayPoolConfigInStore } from "../shared-gateway-pool-read.js";
import { userAllowsInteractiveAccess } from "./lease.js";
export const PARKED_PREWARM_KIND = "prewarm-gateway";
export function parkedPrewarmInput(operation) {
    const { uid, gatewayId, generation, sourceSha, bootImageId, payload } = operation.input;
    if (typeof uid !== "string" || !uid || typeof gatewayId !== "string" || !gatewayId ||
        typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 ||
        typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha) ||
        typeof bootImageId !== "string" || !/^[1-9][0-9]{0,19}$/.test(bootImageId) ||
        !isReleasePayload(payload)) {
        throw new Error("Invalid parked computer prewarm operation input");
    }
    return { uid, gatewayId, generation, sourceSha, bootImageId, payload };
}
export async function readActiveParkedPrewarm(state, uid) {
    const operations = await state.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running"] });
    return operations.find((operation) => operation.output?.prewarmState === "booting" || operation.output?.prewarmState === "handoff") ?? null;
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
export async function startParkedGatewayPrewarm(store, operation, now) {
    const { uid, gatewayId, generation, payload } = parkedPrewarmInput(operation);
    return store.transaction({ label: "isolated-gateway.prewarm-start" }, async (tx) => {
        const [current, root, runtime, owner, pool, empty, conflicts] = await Promise.all([
            tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId),
            tx.fleetRegistry.get(gatewayId), tx.users.records.get(uid), readSharedGatewayPoolConfigInStore(tx),
            tx.gateways.assignments.isEmpty(gatewayId), tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
        ]);
        assertPrewarmWorker(operation, current);
        if (current.output?.prewarmState === "booting")
            return { state: "booting", claim: prewarmClaim(current) };
        if (current.output?.prewarmState === "parked" || current.output?.prewarmState === "handoff")
            return { state: current.output.prewarmState, claim: prewarmClaim(current) };
        if (current.output?.prewarmState === "demand-won")
            return { state: "demand-won" };
        if (hasCustomerDemand(owner?.activationLease?.status))
            return { state: "demand-won" };
        const sharedId = owner?.gateway?.gatewayId;
        const vm = runtime?.vm;
        if (!sharedId || !pool?.sharedGatewayIds.includes(sharedId) || !empty || !owner || !userAllowsInteractiveAccess(owner) ||
            isolatedRuntimeMutationFenced(owner) || root?.desiredStatus !== "paused" || root.gatewayClass !== "isolated" ||
            root.ownerUid !== uid || root.allocation?.claimedByUid !== uid || root.allocation.generation !== generation ||
            root.allocation.kind !== "disposable-builder" || root.liveRelease === null || root.liveRelease !== root.desiredRelease ||
            runtime?.runtime !== "gce-vm" || !vm?.instanceId || vm.status !== "SUSPENDED" ||
            conflicts.some((entry) => entry.id !== operation.id && (entry.kind !== PARKED_PREWARM_KIND || (entry.output?.prewarmState === "booting" || entry.output?.prewarmState === "handoff")))) {
            return { state: "ineligible" };
        }
        const [assignment, release] = await Promise.all([
            tx.gateways.assignments.get(sharedId, uid), tx.gateways.releases.get(gatewayId, root.liveRelease),
            assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId),
        ]);
        if (assignment?.state !== "serving" || assignment.slug !== root.builderSlug || !release)
            return { state: "ineligible" };
        const sameRelease = release.payloadHash === releasePayloadHash(payload);
        const targetRelease = sameRelease ? root.liveRelease : root.latestRelease + 1;
        const claim = {
            release: targetRelease, previousRelease: root.liveRelease, previousInstanceId: vm.instanceId,
            sourceGatewayId: sharedId, sourceAssignmentEpoch: assignment.epoch,
        };
        if (!sameRelease) {
            await tx.gateways.releases.append({
                gatewayId, expectedLatestRelease: root.latestRelease, createdAt: now, createdBy: operation.id,
                sourceRelease: root.liveRelease, note: "Parked computer prewarm", payload,
                payloadHash: releasePayloadHash(payload), activate: true, updatedBy: operation.id,
            });
        }
        await tx.gateways.roots.patch(gatewayId, { desiredStatus: "running", updatedAt: now, updatedBy: operation.id });
        await tx.journal.operations.patch(operation.id, { output: { prewarmState: "booting", ...claim } });
        return { state: "booting", claim };
    });
}
export async function finishParkedGatewayPrewarm(store, operation, now, mode) {
    const { uid, gatewayId, generation, payload } = parkedPrewarmInput(operation);
    return store.transaction({ label: "isolated-gateway.prewarm-finish" }, async (tx) => {
        const [current, root, owner, empty] = await Promise.all([
            tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.users.records.get(uid),
            tx.gateways.assignments.isEmpty(gatewayId),
        ]);
        assertPrewarmWorker(operation, current);
        if (current.output?.prewarmState === "parked" || current.output?.prewarmState === "demand-won")
            return current.output.prewarmState;
        if (current.output?.prewarmState === "handoff" && mode === "ready")
            return "handoff";
        if (current.output?.prewarmState === "handoff" && root?.ownerUid === uid &&
            root.allocation?.generation !== generation && owner?.activationLease?.targetGatewayId === gatewayId)
            return "demand-won";
        const claim = prewarmClaim(current);
        if (!root || root.desiredStatus !== "running" || root.ownerUid !== uid ||
            root.allocation?.claimedByUid !== uid || root.allocation.generation !== generation ||
            root.desiredRelease !== claim.release || !empty || owner?.gateway?.gatewayId === gatewayId) {
            throw new Error("Parked computer prewarm no longer owns the unassigned gateway");
        }
        if (mode === "ready" && root.liveRelease !== claim.release)
            throw new Error("Prewarmed release is not live");
        const lease = owner?.activationLease;
        const requestedSource = lease?.sourceGatewayId;
        if (mode === "ready" && lease?.status === "requested" && requestedSource &&
            owner?.gateway?.gatewayId === requestedSource && lease.entitlementTier === root.sizingProfile) {
            const source = await tx.gateways.roots.get(requestedSource);
            const sourceArtifact = source?.gatewayClass === "shared" && source.liveRelease === source.desiredRelease
                ? await readGatewayArtifactInStore(tx, requestedSource, source.liveRelease) : null;
            if (isDeepStrictEqual(sourceArtifact, gatewayArtifactFromReleasePayload(payload))) {
                await tx.journal.operations.patch(operation.id, { output: { prewarmState: "handoff", ...claim } });
                return "handoff";
            }
        }
        const demand = hasCustomerDemand(lease?.status);
        const state = demand ? "demand-won" : "parked";
        await tx.gateways.roots.patch(gatewayId, {
            desiredStatus: "paused",
            ...(mode === "rollback" && root.liveRelease !== claim.release ? { desiredRelease: claim.previousRelease } : {}),
            updatedAt: now, updatedBy: operation.id,
        }, { revision: root.revision });
        await tx.journal.operations.patch(operation.id, { output: { prewarmState: state, ...claim } });
        return state;
    });
}
