import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { activeParkedPrewarmGatewayIds, PARKED_PREWARM_KIND, parkedPrewarmInput } from "./isolated-gateway-lifecycle/prewarm.js";
import { GUEST_RELEASE_MODE, guestReleaseImagesMatch, guestReleaseInstalled } from "./isolated-gateway-lifecycle/guest-release.js";
function inProgress(operation) {
    return operation.status === "running" || operation.status === "pending";
}
async function verifiedParkedOperation(state, root, matches, request) {
    if (!matches.length || root.liveRelease === null || root.desiredRelease !== root.liveRelease)
        return;
    const [runtime, release] = await Promise.all([
        state.fleetRegistry.get(request.gatewayId), state.gateways.releases.get(request.gatewayId, root.liveRelease),
    ]);
    if (runtime?.vm?.status !== "SUSPENDED" || release?.payloadHash !== releasePayloadHash(request.payload))
        return;
    const instanceId = runtime.vm.instanceId;
    return matches.find(op => op.output?.prewarmState === "parked" && op.output.bootImageId === request.bootImageId &&
        op.output.release === root.liveRelease && op.output.instanceId === instanceId);
}
export function enqueueParkedGatewayPrewarm(store, request) {
    const { gatewayId, uid, sourceSha, bootImageId, payload, createdBy } = request;
    return store.transaction({ label: "isolated-gateway.enqueue-prewarm" }, async (tx) => {
        const [root, owner] = await Promise.all([tx.gateways.roots.get(gatewayId), tx.users.records.get(uid)]);
        if (parkedHomeUnderSnapshotCustody(owner))
            return { status: "ineligible", reason: "user home archive is under snapshot custody" };
        const allocation = root?.allocation;
        if (root?.gatewayClass !== "isolated" || root.ownerUid !== uid || allocation?.kind !== "disposable-builder" || allocation.claimedByUid !== uid) {
            return { status: "ineligible", reason: "parked owner or allocation has changed" };
        }
        const input = { uid, gatewayId, generation: allocation.generation, sourceSha, bootImageId, payload };
        parkedPrewarmInput({ input });
        const history = await tx.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running", "succeeded"] });
        const matches = history.filter(op => op.gatewayId === gatewayId && op.input.generation === input.generation &&
            op.input.sourceSha === sourceSha && op.input.bootImageId === bootImageId);
        const active = matches.find(inProgress);
        if (active)
            return { status: "queued", operationId: active.id };
        const prewarming = activeParkedPrewarmGatewayIds(history.filter(op => op.input.generation === allocation.generation));
        if (root.desiredStatus !== "paused" && (root.desiredStatus !== "running" || !prewarming.has(gatewayId))) {
            return { status: "ineligible", reason: "gateway is no longer parked" };
        }
        const previous = await verifiedParkedOperation(tx, root, matches, request);
        if (previous)
            return { status: "queued", operationId: previous.id };
        const operationId = await tx.journal.operations.enqueue({
            kind: PARKED_PREWARM_KIND, status: "pending", createdBy, createdAt: Date.now(), startedAt: null, completedAt: null,
            input, inputUid: uid, gatewayId, steps: [],
        });
        return { status: "queued", operationId };
    });
}
export function enqueueParkedGuestRelease(store, request) {
    return enqueueGuestRelease(store, request);
}
export function enqueueDemandGuestRelease(store, request) {
    return enqueueGuestRelease(store, request);
}
function guestReleaseRootMatches(root, owner, uid) {
    return root?.gatewayClass === "isolated" && root.ownerUid === uid && root.retirementClaim == null &&
        root.allocation?.kind === "disposable-builder" && root.allocation.claimedByUid === uid && !parkedHomeUnderSnapshotCustody(owner);
}
async function parkedGuestAlreadyInstalled(tx, root, runtime, payload) {
    if (root.desiredStatus !== "paused" || root.liveRelease === null || root.liveRelease !== root.desiredRelease ||
        runtime?.vm?.status !== "SUSPENDED" || !runtime.vm.instanceId)
        return false;
    const release = await tx.gateways.releases.get(root.gatewayId, root.liveRelease);
    return release !== null && guestReleaseImagesMatch(release.payload, payload) &&
        guestReleaseInstalled(payload, runtime.vm.instanceId, runtime.vmImages);
}
function enqueueGuestRelease(store, request) {
    const { gatewayId, uid, payload, createdBy } = request;
    const origin = "sourceSha" in request ? { sourceSha: request.sourceSha } : { demandSource: request.demandSource };
    return store.transaction({ label: "isolated-gateway.enqueue-guest-release" }, async (tx) => {
        const [root, owner, runtime] = await Promise.all([
            tx.gateways.roots.get(gatewayId), tx.users.records.get(uid), tx.fleetRegistry.get(gatewayId),
        ]);
        if (!guestReleaseRootMatches(root, owner, uid)) {
            return { status: "ineligible", reason: "parked owner, allocation or home custody changed" };
        }
        const input = { uid, gatewayId, generation: root.allocation.generation, ...origin, mode: GUEST_RELEASE_MODE, payload };
        parkedPrewarmInput({ input });
        const history = await tx.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running"] });
        const relevant = history.filter(op => op.gatewayId === gatewayId && op.input.generation === input.generation);
        const existing = relevant.find(op => {
            if (op.input.mode !== input.mode)
                return false;
            const candidate = parkedPrewarmInput(op);
            return guestReleaseImagesMatch(candidate.payload, payload);
        });
        if (existing)
            return { status: "queued", operationId: existing.id };
        const prewarming = activeParkedPrewarmGatewayIds(relevant).has(gatewayId);
        if (root.desiredStatus !== "paused" && (root.desiredStatus !== "running" || !prewarming)) {
            return { status: "ineligible", reason: "gateway is no longer parked" };
        }
        if (await parkedGuestAlreadyInstalled(tx, root, runtime, payload))
            return { status: "already-current" };
        const operationId = await tx.journal.operations.enqueue({
            kind: PARKED_PREWARM_KIND, status: "pending", createdBy, createdAt: Date.now(), startedAt: null, completedAt: null,
            input, inputUid: uid, gatewayId, steps: [],
        });
        return { status: "queued", operationId };
    });
}
import { parkedHomeUnderSnapshotCustody } from "./parked-home-archive.js";
