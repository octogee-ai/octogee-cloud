import { randomUUID } from "node:crypto";
import { isValidGatewayId, readUserParkedVm } from "@octogee/shared/types/glm";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
class VmAdmissionError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function withoutRevision(record) {
    const { revision: _revision, ...data } = record;
    return data;
}
function assertBoundVm(runtimeRecord) {
    const vm = object(runtimeRecord?.vm);
    if (runtimeRecord?.runtime !== "gce-vm" || typeof vm.instanceName !== "string" || !vm.instanceName) {
        throw new VmAdmissionError(409, "gateway has no bound VM");
    }
}
async function boundVm(tx, gatewayId) {
    const [stored, runtimeRecord] = await Promise.all([
        tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
    ]);
    const root = stored === null ? null : projectGatewayDesiredRootForGateway(withoutRevision(stored), gatewayId);
    if (!root)
        throw new VmAdmissionError(404, "gateway not found");
    if (root.gatewayClass !== "isolated" || !root.ownerUid || !root.builderSlug || root.desiredStatus === "retired" || root.retirementClaim != null) {
        throw new VmAdmissionError(409, "replacement requires an owned, non-retiring isolated gateway");
    }
    assertBoundVm(runtimeRecord);
    const owner = await tx.users.records.get(root.ownerUid);
    if (owner?.gateway?.gatewayId !== gatewayId) {
        throw new VmAdmissionError(409, "gateway is no longer the owner's current assignment");
    }
    return { gatewayId, ownerUid: root.ownerUid, input: { gatewayId, uid: root.ownerUid, action: "replace" } };
}
async function assertForceRecoverableRoot(tx, gatewayId, ownerUid) {
    const root = await tx.gateways.roots.get(gatewayId);
    if (root !== null && (root.ownerUid !== ownerUid || root.gatewayClass !== "isolated" || !["paused", "retired"].includes(String(root.desiredStatus)))) {
        throw new VmAdmissionError(409, "force recovery requires an absent or stopped, owned isolated gateway");
    }
}
async function parkedVm(tx, ownerUid, force) {
    const owner = await tx.users.records.get(ownerUid);
    if (!owner)
        throw new VmAdmissionError(404, "owner not found");
    const parked = readUserParkedVm({ provisioning: { computer: owner.home.computer } });
    if (!parked)
        throw new VmAdmissionError(404, "owner has no parked VM");
    if (force && (!parked.instanceId || !isValidGatewayId(parked.gatewayId)))
        throw new VmAdmissionError(409, "force recovery requires the parked VM identity");
    if (!force && parked.checkpoint.outcome !== "fresh") {
        throw new VmAdmissionError(409, "park checkpoint is stale; activate the user and replace through its gateway");
    }
    const runtime = await tx.fleetRegistry.get(parked.gatewayId);
    if (object(runtime?.vm).instanceName === parked.instanceName) {
        throw new VmAdmissionError(409, "VM is still bound to a gateway; replace through that gateway");
    }
    if (force)
        await assertForceRecoverableRoot(tx, parked.gatewayId, ownerUid);
    return { gatewayId: parked.gatewayId, ownerUid, input: { ownerUid, uid: ownerUid, action: "replace", ...(force ? { force: true, expectedGatewayId: parked.gatewayId, expectedInstanceId: parked.instanceId } : {}) } };
}
function conflicts(operation, target) {
    const input = object(operation.input);
    return [operation.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId].includes(target.gatewayId)
        || [operation.inputUid, input.uid, input.ownerUid].includes(target.ownerUid);
}
async function servingShared(tx, ownerUid, owner) {
    const gatewayId = owner.gateway?.gatewayId ?? "";
    if (!isValidGatewayId(gatewayId))
        throw new VmAdmissionError(409, "User has no valid serving assignment");
    const root = await tx.gateways.roots.get(gatewayId);
    if (root?.gatewayClass !== "shared")
        throw new VmAdmissionError(409, "VM recovery requires a Shared assignment");
    const assignment = await tx.gateways.assignments.get(gatewayId, ownerUid);
    if (assignment?.uid !== ownerUid || assignment.gatewayId !== gatewayId || assignment.state !== "serving" || !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0)
        throw new VmAdmissionError(409, "VM recovery requires a serving Shared assignment");
    return { gatewayId, epoch: assignment.epoch };
}
function assertInactiveLease(lease) {
    if (lease !== null && !["parked", "failed"].includes(String(lease.status)))
        throw new VmAdmissionError(409, "User activation is in progress");
}
function recoveryOperationMatches(existing, input, ownerUid, fence) {
    return existing.status === "failed" && existing.kind === "gateway-vm" && existing.origin === "operator" && input.action === "replace" && input.force === true &&
        input.ownerUid === ownerUid && input.uid === ownerUid && input.expectedGatewayId === fence.gatewayId && input.expectedInstanceId === fence.instanceId;
}
function replacementOperation(input) {
    return {
        id: input.id, kind: "gateway-vm", status: "pending", createdBy: input.actorUid, origin: "operator",
        createdAt: Date.now(), startedAt: null, completedAt: null, steps: [],
        gatewayId: input.gatewayId, inputUid: input.ownerUid, input: input.input,
    };
}
async function activeOperations(tx) {
    return tx.journal.operations.listByStatus(["pending", "running"]);
}
async function retryForceRecovery(tx, owner, actorUid) {
    const ownerUid = owner.uid;
    const fence = owner.fences.computerRecovery;
    const operationId = fence.operationId;
    if (typeof operationId !== "string" || !operationId || operationId.includes("/") || typeof fence.gatewayId !== "string" || !isValidGatewayId(fence.gatewayId) || typeof fence.instanceId !== "string" || !fence.instanceId)
        throw new VmAdmissionError(409, "VM recovery fence is malformed");
    assertInactiveLease(owner.activationLease);
    const shared = await servingShared(tx, ownerUid, owner);
    const existing = await tx.journal.operations.get(operationId);
    const input = existing ? object(existing.input) : { ownerUid, uid: ownerUid, action: "replace", force: true, expectedGatewayId: fence.gatewayId, expectedInstanceId: fence.instanceId };
    if (existing && !recoveryOperationMatches(existing, input, ownerUid, fence))
        throw new VmAdmissionError(409, "VM recovery is already in progress or cannot be retried");
    const target = { ownerUid, gatewayId: fence.gatewayId, input };
    if ((await activeOperations(tx)).some(candidate => {
        const candidateInput = object(candidate.input);
        const fencedPending = candidate.status === "pending" && (candidateInput.uid === ownerUid || (candidateInput.uid == null && candidateInput.ownerUid === ownerUid));
        return conflicts(candidate, target) && !fencedPending;
    }))
        throw new VmAdmissionError(409, "conflicting VM operation is in progress");
    await tx.users.records.setFence(ownerUid, "computerRecovery", { ...fence, sharedGatewayId: shared.gatewayId, assignmentEpoch: shared.epoch });
    if (existing) {
        await tx.journal.operations.patch(operationId, {
            status: "pending", startedAt: null, completedAt: null, steps: [],
            error: { clear: true }, expireAt: { clear: true }, nextAttemptAt: { clear: true },
        });
    }
    else {
        await tx.journal.operations.create(replacementOperation({ id: operationId, actorUid, gatewayId: fence.gatewayId, ownerUid, input }));
    }
    return operationId;
}
async function fenceForceRecovery(tx, target, operationId) {
    const owner = await tx.users.records.get(target.ownerUid);
    if (!owner)
        throw new VmAdmissionError(404, "owner not found");
    if (owner.fences.computerRecovery !== undefined)
        throw new VmAdmissionError(409, "VM recovery is already in progress");
    assertInactiveLease(owner.activationLease);
    const shared = await servingShared(tx, target.ownerUid, owner);
    await tx.users.records.setFence(target.ownerUid, "computerRecovery", {
        operationId, gatewayId: target.gatewayId, instanceId: target.input.expectedInstanceId,
        sharedGatewayId: shared.gatewayId, assignmentEpoch: shared.epoch,
    });
}
async function enqueueReplacement(store, requested, actorUid) {
    const operationId = randomUUID();
    return store.transaction({ label: "admin.computer.replace" }, async (tx) => {
        if ("force" in requested && requested.force) {
            const owner = await tx.users.records.get(requested.ownerUid);
            if (owner?.fences.computerRecovery !== undefined)
                return retryForceRecovery(tx, owner, actorUid);
        }
        const target = "gatewayId" in requested
            ? await boundVm(tx, requested.gatewayId)
            : await parkedVm(tx, requested.ownerUid, requested.force === true);
        const conflict = (await activeOperations(tx)).find((operation) => conflicts(operation, target));
        if (conflict)
            throw new VmAdmissionError(409, `VM operation already in flight: ${conflict.id}`);
        if ("force" in requested && requested.force)
            await fenceForceRecovery(tx, target, operationId);
        await tx.journal.operations.create(replacementOperation({
            id: operationId, actorUid, gatewayId: target.gatewayId, ownerUid: target.ownerUid, input: target.input,
        }));
        return operationId;
    });
}
function forceRequested(req, key) {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body))
        throw new VmAdmissionError(400, "invalid VM replacement request");
    const force = key === "ownerUid" && body.force === true && body.acceptBootDataLoss === true && Object.keys(body).length === 2;
    if (Object.keys(body).length !== 0 && !force)
        throw new VmAdmissionError(400, "force recovery requires force and acceptBootDataLoss");
    return force;
}
function requestedVm(req, key) {
    const params = req.params;
    const id = key === "gatewayId" ? params.id : params.uid;
    if (typeof id !== "string" || !id || id.includes("/") || id.length > 256 || (key === "gatewayId" && !isValidGatewayId(id))) {
        throw new VmAdmissionError(400, "invalid VM identity");
    }
    const force = forceRequested(req, key);
    return key === "gatewayId" ? { gatewayId: id } : { ownerUid: id, ...(force ? { force: true } : {}) };
}
export function addAdminComputerRoutes(router, deps) {
    for (const [path, key] of [["/gateways/:id/vm/replace", "gatewayId"], ["/users/:uid/vm/replace", "ownerUid"]]) {
        router.post(path, async (req, res, next) => {
            try {
                const actor = req;
                if (!actor.uid) {
                    res.status(401).json({ error: "Unauthenticated" });
                    return;
                }
                if (!actor.isAdmin) {
                    res.status(403).json({ error: "Admin access required" });
                    return;
                }
                if (!deps.replacementEnabled)
                    throw new VmAdmissionError(409, "VM replacement is unavailable in this release; the existing VM and home are retained.");
                const requested = requestedVm(req, key);
                const force = "force" in requested && requested.force === true;
                const operationId = await deps.journal({
                    req, what: "replace VM", why: force ? "operator accepted possible boot data loss for force recovery" : "admin fleet request", target: requested,
                    preActionStatus: { binding: key === "gatewayId" ? "gateway" : "parked-owner" },
                    mutation: { kind: "replace-computer", ...requested },
                    ...(force ? { forced: true } : {}),
                    action: () => enqueueReplacement(deps.store, requested, actor.uid),
                });
                res.status(202).json({ ...requested, operationId });
            }
            catch (error) {
                if (error instanceof VmAdmissionError)
                    res.status(error.status).json({ error: error.message });
                else
                    next(error);
            }
        });
    }
}
