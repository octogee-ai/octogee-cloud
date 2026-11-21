import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { PARKED_PREWARM_KIND, parkedPrewarmInput } from "./isolated-gateway-lifecycle/prewarm.js";
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
        if (owner?.home.homeArchive !== undefined && owner.home.homeArchive.phase !== "restored")
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
        if (root.desiredStatus !== "paused")
            return { status: "ineligible", reason: "gateway is no longer parked" };
        if (history.some(inProgress)) {
            throw new Error(`Another parked computer upgrade is active for ${gatewayId}`);
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
