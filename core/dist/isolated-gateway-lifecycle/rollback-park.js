import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { userActivationRecoveryTargetMatches } from "../fleet-state.js";
import { ISOLATED_GATEWAY_LIFECYCLE_ACTOR, } from "./inputs.js";
import { exactLeaseFence, nextFailedActivationLease, recordActivationFailure, userAllowsInteractiveAccess } from "./lease.js";
function uniqueStepTime(operation, name, status) {
    const [step, duplicate] = operation.steps.filter(candidate => candidate.name === name);
    return step?.status === status && duplicate === undefined ? step.completedAt ?? null : null;
}
function terminalRollback(operation) {
    return operation.kind === "migrate-user" && operation.status === "failed" &&
        operation.cutoverCommittedAt === undefined && operation.userMigrationV2 === undefined &&
        operation.cancellationRequestedAt === undefined && operation.sourceTransferExecution === undefined &&
        operation.input.recoverSourceOnly !== true && operation.schedulerHandoffReleased === true &&
        operation.schedulerHandoffLost === undefined;
}
function releasedSchedulerMatches(operation, input) {
    const handoff = operation.schedulerHandoff;
    if (!handoff)
        return false;
    const identity = readSchedulerMigrationIdentity(operation.id, handoff.migrationId);
    return identity !== null && identity.claimStartedAt === operation.startedAt && identity.attempt === operation.attempts &&
        handoff.uid === input.uid && handoff.slug === input.slug &&
        handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId &&
        handoff.forwardRecovery === undefined && handoff.sourceRecovery === undefined &&
        handoff.stageAfterCutover === true && operation.input.userSlug === input.slug;
}
function confirmedRollbackUnmountAt(operation, input) {
    if (!terminalRollback(operation) || !releasedSchedulerMatches(operation, input))
        return null;
    const unmountedAt = uniqueStepTime(operation, "rollback:unmount-target", "done");
    const timestamps = [
        operation.startedAt,
        uniqueStepTime(operation, "quiesce-source", "done"),
        uniqueStepTime(operation, "final-sync-state", "failed") ?? uniqueStepTime(operation, "verify-target", "failed"),
        unmountedAt,
        uniqueStepTime(operation, "rollback:resume-ingress", "done"),
        operation.schedulerHandoffReleasedAt,
        operation.completedAt,
    ];
    if (!timestamps.every((at) => typeof at === "number" && Number.isSafeInteger(at) && at > 0))
        return null;
    return timestamps.every((at, index) => index === 0 || timestamps[index - 1] <= at) ? unmountedAt : null;
}
function servingRollbackSource(assignments, input) {
    const [source, extra] = assignments;
    return extra === undefined && source?.uid === input.uid && source.slug === input.slug &&
        source.gatewayId === input.sourceGatewayId && source.state === "serving" &&
        source.epoch === input.sourceEpoch && source.updatedByOperationId === input.operationId;
}
function currentRunningRollbackVm(runtime, root, unmountedAt) {
    const vm = runtime.vm;
    return runtime.gatewayId === root.gatewayId && runtime.runtime === "gce-vm" &&
        runtime.lifecycle === "serving" && runtime.release === root.liveRelease &&
        vm?.status === "RUNNING" && typeof vm.instanceId === "string" && /^[1-9]\d*$/.test(vm.instanceId) &&
        typeof vm.startedAt === "number" && vm.startedAt <= unmountedAt;
}
function emptyRuntimeAfterRollback(runtime, root, unmountedAt, now) {
    if (!runtime || !currentRunningRollbackVm(runtime, root, unmountedAt))
        return false;
    const heartbeat = runtime.heartbeat;
    const observedAt = heartbeat?.lastHeartbeatAt;
    return heartbeat?.status === "ready" && typeof observedAt === "number" &&
        observedAt >= unmountedAt && observedAt <= now && now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS &&
        Array.isArray(heartbeat.mountedCustomers) && heartbeat.mountedCustomers.length === 0 &&
        Array.isArray(heartbeat.migratingIn) && heartbeat.migratingIn.length === 0;
}
function compatibleOwnerFences(user) {
    const { pendingNativeSchedulerRetirement: dormant, ...active } = user.fences;
    if (Object.keys(active).length !== 0)
        return false;
    if (dormant === undefined)
        return true;
    const home = user.home.homeDisk;
    return dormant.uid === user.uid && dormant.slug === user.slug && typeof home?.id === "string" &&
        /^[1-9]\d*$/.test(home.id) && typeof home.source === "string" && home.source.length > 0 &&
        dormant.homeDiskId === home.id && dormant.homeDiskSource === home.source;
}
function unfencedActivation(user, lease, request) {
    return userAllowsInteractiveAccess(user) && compatibleOwnerFences(user) &&
        lease.status === "activating" && lease.activationOperationId === request.operationId &&
        request.operationId === builderActivateOperationId(request.targetGatewayId, request.generation);
}
function mutableRollbackRoot(root, slug) {
    return root.builderSlug === slug && root.desiredStatus === "running" && root.liveRelease !== null &&
        root.liveRelease === root.desiredRelease && root.runtimeRestartFence === undefined && root.retirementClaim == null;
}
function hasActiveGatewayWork(operations) {
    return operations.some(entry => entry.status === "pending" || entry.status === "running");
}
async function readRollbackParkEvidence(tx, uid, sourceGatewayId, targetGatewayId, operationId) {
    const [sourceRoot, targetRoot, operation, assignments, targetEmpty, runtime, ownerWork, gatewayWork, inputGatewayWork] = await Promise.all([
        tx.gateways.roots.get(sourceGatewayId),
        tx.gateways.roots.get(targetGatewayId),
        tx.journal.operations.get(operationId),
        tx.gateways.assignments.listForUid(uid),
        tx.gateways.assignments.isEmpty(targetGatewayId),
        tx.fleetRegistry.get(targetGatewayId),
        tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
        tx.journal.operations.listByGateway(targetGatewayId),
        tx.journal.operations.listByInputGateway(targetGatewayId),
    ]);
    const busy = ownerWork.length > 0 || hasActiveGatewayWork(gatewayWork) || hasActiveGatewayWork(inputGatewayWork);
    return { sourceRoot, targetRoot, operation, assignments, targetEmpty, runtime, busy };
}
function rollbackSource(user, lease) {
    const sourceGatewayId = lease.sourceGatewayId;
    const sourceEpoch = lease.sourceAssignmentEpoch;
    const slug = user.slug;
    if (!sourceGatewayId || user.gateway?.gatewayId !== sourceGatewayId || !slug ||
        typeof sourceEpoch !== "number" || !Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0)
        return null;
    return { sourceGatewayId, sourceEpoch, slug };
}
function rollbackTarget(operation, targetRoot, lease, identity) {
    const { uid, slug, sourceGatewayId, sourceEpoch, targetGatewayId, assignments } = identity;
    const operationId = operation.id;
    if (!servingRollbackSource(assignments, { uid, slug, sourceGatewayId, sourceEpoch, operationId }) ||
        !userActivationRecoveryTargetMatches({
            operationId, input: operation.input, openclaw: { activationLease: lease }, sourceEpoch, targetRoot,
        }))
        return null;
    return confirmedRollbackUnmountAt(operation, { uid, slug, fromGatewayId: sourceGatewayId, toGatewayId: targetGatewayId });
}
async function rollbackParkRoot(tx, deps, request, owner) {
    const { user, lease, now } = owner;
    const source = rollbackSource(user, lease);
    if (!source)
        return null;
    const { uid, targetGatewayId, operationId } = request;
    const { sourceRoot, targetRoot, operation, assignments, targetEmpty, runtime, busy } = await readRollbackParkEvidence(tx, uid, source.sourceGatewayId, targetGatewayId, operationId);
    if (sourceRoot?.gatewayClass !== "shared" || !targetRoot || !mutableRollbackRoot(targetRoot, source.slug) ||
        !targetEmpty || busy || !operation || deps.sourceRecoveryPending(operation))
        return null;
    const unmountedAt = rollbackTarget(operation, targetRoot, lease, { ...source, uid, targetGatewayId, assignments });
    return unmountedAt !== null && emptyRuntimeAfterRollback(runtime, targetRoot, unmountedAt, now) ? targetRoot : null;
}
async function previouslyParkedFailure(tx, request) {
    const [root, receipt] = await Promise.all([
        tx.gateways.roots.get(request.targetGatewayId),
        tx.users.placementReceipts.get(request.uid, request.leaseId, request.generation, "activation-failed"),
    ]);
    return root?.ownerUid === request.uid && root.desiredStatus === "paused" &&
        root.allocation?.leaseId === request.leaseId && root.allocation.generation === request.generation &&
        receipt?.gatewayId === request.targetGatewayId && receipt.operationId === request.operationId && receipt.retirementOperationId === null;
}
export async function tryFailActivationLeaseAndPark(deps, request, mode = "apply") {
    return deps.store.transaction({ label: "disposable-gateway.fail-lease-and-park", readOnly: mode === "plan" }, async (tx) => {
        await deps.requireOwner(tx);
        const user = await tx.users.records.get(request.uid);
        const lease = user?.activationLease;
        if (!user || !lease || lease.leaseId !== request.leaseId || lease.generation !== request.generation ||
            lease.targetGatewayId !== request.targetGatewayId)
            return false;
        if (lease.status === "failed")
            return previouslyParkedFailure(tx, request);
        if (!unfencedActivation(user, lease, request))
            return false;
        const now = deps.now();
        const next = nextFailedActivationLease(lease, request, now);
        const root = await rollbackParkRoot(tx, deps, request, { user, lease, now });
        if (!next || !root)
            return false;
        if (mode === "apply") {
            await tx.gateways.roots.patch(root.gatewayId, {
                desiredStatus: "paused", updatedBy: ISOLATED_GATEWAY_LIFECYCLE_ACTOR, updatedAt: now,
            }, { revision: root.revision });
            await recordActivationFailure(tx, lease, request, now, true);
            await tx.users.records.setActivationLease(request.uid, next, exactLeaseFence(lease, ["activating"]));
        }
        return true;
    });
}
