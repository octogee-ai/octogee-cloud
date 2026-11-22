import { NATIVE_RETURN_TARGET_EXCLUSION, nativeReturnTargetDenied, nativeReturnTargetExclusionId, readNativeOldTargetRetirement, readNativeReturnTargetDrain, sharedDrainPodMatches } from "./native-return-target-deny.js";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { moveHasNotBegun } from "./gateway-retirement-claim.js";
import { buildOperationAuditIntent } from "./operation-audit.js";
export class HeldNativeReturnConflict extends Error {
}
function requireConflict(condition, message) {
    if (!condition)
        throw new HeldNativeReturnConflict(message);
}
function matchesScope(op, selection) {
    const input = op.input;
    return [op.id === selection.operationId, op.kind === "migrate-user", op.origin === "automatic",
        op.createdBy === "glm-controller-placement-policy", input?.source === "builder-activation-lease",
        op.inputUid === input?.uid, input?.fromGatewayId === selection.sourceGatewayId, input?.toGatewayId === selection.targetGatewayId,
        op.gatewayId === selection.targetGatewayId, op.cutoverCommittedAt === undefined, op.cancellationRequestedAt === undefined,
        op.sourceTransferExecution === undefined, op.userMigrationV2 === undefined, op.restoreAttempt === undefined,
        op.schedulerHandoffReleased === false, op.schedulerHandoffLost === undefined].every(Boolean);
}
function journalHold(op, selection) {
    requireConflict(op && matchesScope(op, selection), "Held Native return journal scope changed");
    const handoff = op.schedulerHandoff;
    const uid = op.input.uid;
    const slug = op.input.userSlug;
    requireConflict(typeof uid === "string" && typeof slug === "string" && handoff?.forwardRecovery, "Held Native return lacks source authority");
    const forward = handoff.forwardRecovery;
    requireConflict([
        handoff.uid === uid, handoff.slug === slug, handoff.fromGatewayId === selection.sourceGatewayId,
        handoff.toGatewayId === selection.targetGatewayId, handoff.migrationId === selection.schedulerMigrationId,
        readSchedulerMigrationIdentity(op.id, handoff.migrationId) !== null, handoff.sourceRecovery === undefined,
        handoff.stageAfterCutover === undefined, handoff.stagedAt === undefined, forward.schemaVersion === 1,
        forward.phase === "source-flushed", forward.sourceEpoch === selection.sourceEpoch, forward.targetReleased === undefined,
    ].every(Boolean), "Held Native return scheduler checkpoint changed");
    return { op, handoff: { ...handoff, forwardRecovery: forward }, uid, slug };
}
function missingFingerprintAttempt({ op, handoff, slug }) {
    const attempt = op.attemptHistory?.at(-1), checkpoint = handoff.forwardRecovery;
    const prefix = `migration forward recovery pending: status 503: /push-rsync-state/${handoff.fromGatewayId}: 500 `;
    if (!attempt?.error?.startsWith(prefix) || attempt.steps?.length !== 2)
        return false;
    const [keys, transfer] = attempt.steps;
    let failure;
    try {
        failure = JSON.parse(attempt.error.slice(prefix.length));
    }
    catch {
        return false;
    }
    return [checkpoint.sourceSystemConfigCommit === undefined, attempt.attempt === op.attempts,
        attempt.classification === "transient",
        keys?.name === "keys-sync-state", keys?.status === "done",
        transfer?.name === "transfer-agent-store", transfer?.status === "failed",
        failure?.error === "push-rsync-state failed",
        failure?.message === `[migration-activation:${slug}] source has no applied fingerprint; converge it before migration`].every(Boolean);
}
function mayHoldOriginalVm(status, maintenance) {
    if (!maintenance)
        return status === "RUNNING";
    if (maintenance.phase === "reserved")
        return ["RUNNING", "STOPPING", "TERMINATED"].includes(status ?? "");
    return status === "TERMINATED";
}
function isHeldBuilderRuntime(source, runtime, lease, maintenance) {
    const allocation = source.allocation;
    return allocation?.kind === "disposable-builder" && allocation.leaseId === lease.leaseId &&
        allocation.generation === lease.generation && runtime?.runtime === "gce-vm" && mayHoldOriginalVm(runtime.vm?.status, maintenance) &&
        (!maintenance || runtime.vm?.instanceId === maintenance.originalInstanceId);
}
function targetReleaseMatches(target, maintenance) {
    return maintenance ? target.desiredRelease === maintenance.desired && target.liveRelease === maintenance.original :
        target.liveRelease === target.desiredRelease;
}
function heldReturnTargetHeartbeatMatches(heartbeat, slug, verifyReady) {
    return (!verifyReady || heartbeat.status === "ready") && !heartbeat.mountedCustomers.includes(slug) &&
        !heartbeat.migratingIn?.includes(slug);
}
export const HELD_NATIVE_OFFLINE_SOURCE_FENCE_KIND = "held-native-offline-source";
function sourceFenceMatches(fence, maintenance) {
    if (!maintenance)
        return !fence;
    return fence?.kind === HELD_NATIVE_OFFLINE_SOURCE_FENCE_KIND && fence.attemptId === maintenance.requestId && fence.phase === maintenance.phase;
}
function targetHoldsReturn(target, runtime, slug, check) {
    return [target.gatewayClass === "shared", target.desiredStatus === "running" || check?.allowDraining && target.desiredStatus === "draining", targetReleaseMatches(target, check?.release),
        Number.isSafeInteger(target.liveRelease), target.retirementClaim == null, isDeepStrictEqual(target.runtimeRestartFence, check?.fence),
        heldReturnTargetHeartbeatMatches(runtime.heartbeat, slug, check?.requireReady ?? true)].every(Boolean);
}
function heldTargetRelease(target, runtime, slug, check) {
    if (check && "retiredRelease" in check)
        return runtime === null ? check.retiredRelease : null;
    return target && runtime && targetHoldsReturn(target, runtime, slug, check) ? target.liveRelease : null;
}
async function holdingCustody(state, { op, handoff, uid, slug }, maintenance, targetCheck) {
    const { fromGatewayId, toGatewayId, forwardRecovery } = handoff;
    const user = await state.users.records.get(uid);
    const lease = user?.activationLease;
    const marker = user?.fences.migration;
    const source = await state.gateways.roots.get(fromGatewayId);
    const target = await state.gateways.roots.get(toGatewayId);
    const [assignment, ...otherAssignments] = await state.gateways.assignments.listForUid(uid);
    const sourceRuntime = await state.fleetRegistry.get(fromGatewayId);
    const targetRuntime = await state.fleetRegistry.get(toGatewayId);
    requireConflict(user && lease && marker && source && assignment, "Held Native return custody cannot be verified");
    const targetRelease = heldTargetRelease(target, targetRuntime, slug, targetCheck);
    requireConflict([
        user.gateway?.gatewayId === fromGatewayId, user.slug === slug, Object.keys(user.fences).length === 1,
        lease.status === "returning", lease.targetGatewayId === fromGatewayId, lease.returnOperationId === op.id,
        op.id === builderReturnOperationId(fromGatewayId, lease.generation), marker.operationId === op.id,
        marker.state === "moving", marker.phase === "transferring", otherAssignments.length === 0,
        assignment.gatewayId === fromGatewayId, assignment.uid === uid, assignment.slug === slug,
        assignment.epoch === forwardRecovery.sourceEpoch, assignment.state === "quiescing", assignment.updatedByOperationId === op.id,
        source.gatewayClass === "isolated", source.ownerUid === uid, source.builderSlug === slug,
        isHeldBuilderRuntime(source, sourceRuntime, lease, maintenance),
        source.desiredStatus === "running", source.liveRelease === source.desiredRelease, Number.isSafeInteger(source.liveRelease),
        source.retirementClaim == null, sourceFenceMatches(source.runtimeRestartFence, maintenance),
        typeof targetRelease === "number" && Number.isSafeInteger(targetRelease),
    ].every(Boolean), "Held Native return source or target custody changed");
    const active = await state.journal.operations.listForUid(uid, { statuses: ["pending", "running"] });
    requireConflict(active.length === 1 && active[0]?.id === op.id, "A different operation holds the Native return owner");
    return { sourceRelease: source.liveRelease, targetRelease: targetRelease, originalInstanceId: sourceRuntime?.vm?.instanceId };
}
export async function readHeldNativeReturnForTargetMaintenance(state, selection, targetFence, maintenanceRelease) {
    const hold = journalHold(await state.journal.operations.get(selection.operationId), selection);
    const targetImportHold = hold.handoff.forwardRecovery.sharedTargetImportHold;
    requireConflict(hold.op.status === "pending" && hold.op.startedAt === null && hold.op.completedAt === null &&
        !hold.handoff.forwardRecovery.sourceReconcile && hold.handoff.forwardRecovery.offlineSourceRecovery === undefined && missingFingerprintAttempt(hold), "Held Native return is not the original unclaimed missing-fingerprint checkpoint");
    requireConflict(targetFence
        ? targetImportHold?.gatewayId === selection.targetGatewayId && targetImportHold.maintenanceAttemptId === targetFence.attemptId
        : targetImportHold === undefined, "Held Native return Shared import hold changed");
    const releases = await holdingCustody(state, hold, undefined, { fence: targetFence, requireReady: targetFence === undefined, release: maintenanceRelease });
    return { ...releases, uid: hold.uid, slug: hold.slug };
}
function requestId(selection) {
    return createHash("sha256").update(JSON.stringify([selection.operationId, selection.sourceGatewayId, selection.targetGatewayId,
        selection.sourceEpoch, selection.schedulerMigrationId])).digest("hex");
}
export async function requestHeldNativeReturnRepair(store, selection, actor, now, dryRun = false) {
    const id = requestId(selection);
    return store.transaction({ label: "held-native-return.request-source-reconcile", readOnly: dryRun }, async (tx) => {
        const hold = journalHold(await tx.journal.operations.get(selection.operationId), selection);
        const authority = { ...selection, uid: hold.uid, slug: hold.slug, requestId: id };
        requireConflict(!await readNativeReturnTargetDrain(tx, hold.op), "Held Native return is reserved for a Shared target drain");
        requireConflict(!hold.handoff.forwardRecovery.offlineSourceRecovery, "Held Native return selected an offline source");
        requireConflict(!hold.handoff.forwardRecovery.sharedTargetImportHold, "Held Native return requires offline custody for the retained Shared target");
        const previous = hold.handoff.forwardRecovery.sourceReconcile;
        if (previous?.requestId !== id) {
            requireConflict(!previous && hold.op.status === "pending" && hold.op.startedAt === null && hold.op.completedAt === null &&
                missingFingerprintAttempt(hold), "Held Native return has no matching unclaimed missing-fingerprint attempt");
            const { originalInstanceId: _original, ...releases } = await holdingCustody(tx, hold);
            requireConflict(typeof hold.op.attempts === "number", "Held Native return attempt is unavailable");
            if (!dryRun) {
                const sourceReconcile = { ...releases, requestId: id, requestedAt: now, requestedBy: actor,
                    failureAttempt: hold.op.attempts };
                const audit = buildOperationAuditIntent({
                    actor, forced: false, what: "Request reconciliation of a held Native return source",
                    why: "The original quiesced source reported a missing applied runtime fingerprint",
                    target: authority, preActionStatus: { ...releases, attempt: hold.op.attempts }, mutation: { ...selection, requestId: id },
                    idempotencyKey: `held-native-return-reconcile:${id}`, now: () => now,
                });
                await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "completed", lifecycleStage: "action-completed",
                    actionClaimId: id, actionStartedAt: now, actionRecoveryCount: 0, completedAt: now, outcome: "completed" });
                await tx.journal.operations.patch(hold.op.id, {
                    schedulerHandoff: { ...hold.handoff, forwardRecovery: { ...hold.handoff.forwardRecovery, sourceReconcile } },
                    nextAttemptAt: { clear: true },
                }, { revision: hold.op.revision, status: ["pending"] });
            }
        }
        return authority;
    });
}
async function currentHeldClaim(state, { authority, claimStartedAt }) {
    const observation = journalHold(await state.journal.operations.get(authority.operationId), authority);
    const marker = observation.handoff.forwardRecovery.sourceReconcile;
    requireConflict(!observation.handoff.forwardRecovery.offlineSourceRecovery && marker && !marker.receipt && marker.requestId === authority.requestId &&
        observation.op.status === "running" && observation.op.startedAt === claimStartedAt &&
        observation.uid === authority.uid && observation.slug === authority.slug && requestId(authority) === marker.requestId, "Held Native return source reconcile claim changed");
    const { originalInstanceId: _original, ...actual } = await holdingCustody(state, observation);
    requireConflict(isDeepStrictEqual(actual, { sourceRelease: marker.sourceRelease, targetRelease: marker.targetRelease }), "Held Native return release custody changed");
    return { ...observation, marker };
}
export async function assertHeldNativeReturnRepairClaim(store, claim) {
    await store.transaction({ label: "held-native-return.read-current-repair-claim", readOnly: true }, tx => currentHeldClaim(tx, claim));
}
export async function completeHeldNativeReturnRepair(store, claim, proof, now) {
    requireConflict(Number.isSafeInteger(proof.verifiedAt) && proof.verifiedAt >= claim.claimStartedAt && proof.verifiedAt <= now &&
        /^[a-f0-9]{16}$/.test(proof.appliedFingerprint) && /^[a-f0-9]{64}$/.test(proof.activationManifestSha256), "Held Native return source proof is unavailable");
    return store.transaction({ label: "held-native-return.persist-reconciled-source" }, async (tx) => {
        const { op, handoff, marker } = await currentHeldClaim(tx, claim);
        const schedulerHandoff = { ...handoff, forwardRecovery: {
                ...handoff.forwardRecovery,
                sourceReconcile: { ...marker, receipt: proof },
            } };
        await tx.journal.operations.patch(op.id, { schedulerHandoff }, { status: ["running"], startedAt: claim.claimStartedAt, revision: op.revision });
        return schedulerHandoff;
    });
}
function offlineRequestId(selection) {
    return createHash("sha256").update(`held-native-offline:${requestId(selection)}`).digest("hex");
}
function offlineAuthority(selection, hold) {
    return { ...selection, uid: hold.uid, slug: hold.slug, requestId: offlineRequestId(selection) };
}
function offlineFence(gatewayId, recovery) {
    return { gatewayId, attemptId: recovery.requestId, kind: HELD_NATIVE_OFFLINE_SOURCE_FENCE_KIND, phase: recovery.phase, startedAt: recovery.requestedAt };
}
export async function reserveHeldNativeOfflineSource(store, selection, actor, now, dryRun = false) {
    return store.transaction({ label: "held-native-return.reserve-offline-source", readOnly: dryRun }, async (tx) => {
        const hold = journalHold(await tx.journal.operations.get(selection.operationId), selection);
        const authority = offlineAuthority(selection, hold);
        requireConflict(!await readNativeReturnTargetDrain(tx, hold.op), "Held Native return is reserved for a Shared target drain");
        const previous = hold.handoff.forwardRecovery.offlineSourceRecovery;
        if (previous) {
            requireConflict(previous.requestId === authority.requestId, "Held Native offline request changed");
        }
        else {
            requireConflict(!hold.handoff.forwardRecovery.sourceReconcile && hold.op.status === "pending" &&
                hold.op.startedAt === null && hold.op.completedAt === null && missingFingerprintAttempt(hold), "Held Native return has no matching unclaimed source for offline custody");
            const { originalInstanceId, ...releases } = await holdingCustody(tx, hold);
            requireConflict(originalInstanceId && /^[1-9]\d*$/.test(originalInstanceId) && typeof hold.op.attempts === "number", "Held Native return has no numeric original VM or attempt");
            const offline = {
                ...releases, phase: "reserved", requestId: authority.requestId, requestedAt: now, originalInstanceId,
                failureAttempt: hold.op.attempts,
            };
            if (!dryRun)
                await persistOfflineReservation(tx, authority, hold, offline, { actor, now });
        }
        return authority;
    });
}
async function persistOfflineReservation(tx, authority, hold, offline, options) {
    const { actor, now } = options;
    const audit = buildOperationAuditIntent({
        actor, forced: false, what: "Reserve the held Native return source for offline custody",
        why: "Protect the quiesced original before alternate source recovery",
        target: { ...authority }, preActionStatus: { failureAttempt: offline.failureAttempt }, mutation: { ...offline },
        idempotencyKey: `held-native-offline-reserve:${offline.requestId}`, now: () => now,
    });
    await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "completed", lifecycleStage: "action-completed",
        actionClaimId: offline.requestId, actionStartedAt: now, actionRecoveryCount: 0, completedAt: now, outcome: "completed" });
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(authority.sourceGatewayId, null, offlineFence(authority.sourceGatewayId, offline));
    await tx.journal.operations.patch(hold.op.id, { schedulerHandoff: offlineHandoff(hold, offline) }, { revision: hold.op.revision, status: ["pending"] });
}
function offlineHandoff(hold, offline) {
    return { ...hold.handoff, forwardRecovery: { ...hold.handoff.forwardRecovery, offlineSourceRecovery: offline } };
}
export async function readReservedHeldNativeOfflineSource(store, selection) {
    return store.transaction({ label: "held-native-return.read-reserved-offline-source", readOnly: true }, async (tx) => {
        const hold = journalHold(await tx.journal.operations.get(selection.operationId), selection);
        const authority = offlineAuthority(selection, hold);
        const offline = hold.handoff.forwardRecovery.offlineSourceRecovery;
        requireConflict(offline?.requestId === authority.requestId && offline.phase === "reserved" &&
            hold.op.status === "pending" && hold.op.startedAt === null && hold.op.completedAt === null, "Held Native offline original no longer has an unclaimed reservation");
        await verifyOfflineReleaseCustody(tx, hold, offline);
        return { authority, originalInstanceId: offline.originalInstanceId, reservedAt: offline.requestedAt };
    });
}
export async function bindHeldNativeStoppedOriginal(store, selection, witness, actor, now) {
    return store.transaction({ label: "held-native-return.bind-stopped-original" }, async (tx) => {
        const hold = journalHold(await tx.journal.operations.get(selection.operationId), selection);
        const authority = offlineAuthority(selection, hold);
        const offline = hold.handoff.forwardRecovery.offlineSourceRecovery;
        requireConflict(offline?.requestId === authority.requestId && offline.phase === "reserved" &&
            hold.op.status === "pending" && hold.op.startedAt === null && offline.originalInstanceId === witness.originalInstanceId &&
            Number.isSafeInteger(witness.stoppedAt) && witness.stoppedAt >= offline.requestedAt && witness.stoppedAt <= now, "Held Native stopped original does not match the reserved source");
        await verifyOfflineReleaseCustody(tx, hold, offline);
        const next = { ...offline, phase: "stopped-original", stoppedAt: witness.stoppedAt };
        await tx.gateways.roots.compareAndSetRuntimeRestartFence(authority.sourceGatewayId, offlineFence(authority.sourceGatewayId, offline), offlineFence(authority.sourceGatewayId, next));
        const sourceRuntime = await tx.fleetRegistry.get(authority.sourceGatewayId);
        requireConflict(sourceRuntime?.runtime === "gce-vm" && sourceRuntime.vm?.instanceId === witness.originalInstanceId, "Held Native stopped original registry identity changed");
        await tx.fleetRegistry.patch(authority.sourceGatewayId, {
            vm: { ...sourceRuntime.vm, status: "TERMINATED", stopReason: "operator", internalIp: null },
        }, { vmInstanceId: witness.originalInstanceId });
        const audit = buildOperationAuditIntent({
            actor, forced: false, what: "Bind an externally stopped Native source",
            why: "Observe the exact provider-stopped original before alternate dispatch",
            target: { ...authority }, preActionStatus: { ...offline }, mutation: { ...witness },
            idempotencyKey: `held-native-offline-stopped:${offline.requestId}`, now: () => now,
        });
        await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "completed", lifecycleStage: "action-completed",
            actionClaimId: offline.requestId, actionStartedAt: now, actionRecoveryCount: 0, completedAt: now, outcome: "completed" });
        await tx.journal.operations.patch(hold.op.id, { schedulerHandoff: offlineHandoff(hold, next), nextAttemptAt: { clear: true } }, { revision: hold.op.revision, status: ["pending"] });
        return authority;
    });
}
function validOriginalRestart(offline, witness, now) {
    return (offline.phase === "stopped-original" || offline.phase === "staged-offline") &&
        offline.originalInstanceId === witness.originalInstanceId && typeof offline.stoppedAt === "number" &&
        Number.isSafeInteger(witness.restartedAt) && witness.restartedAt > offline.stoppedAt && witness.restartedAt <= now &&
        isIP(witness.internalIp) === 4 && witness.cleanFileSha256 === witness.restartedFileSha256 &&
        [witness.cleanFileSha256, witness.ownerAnchorSha256].every(value => /^[a-f0-9]{64}$/.test(value)) &&
        (!offline.stage || offline.stage.ownerAnchorSha256 === witness.ownerAnchorSha256);
}
export async function recordHeldNativeOriginalRestart(store, selection, witness, actor, now) {
    return store.transaction({ label: "held-native-return.record-original-restart" }, async (tx) => {
        const hold = journalHold(await tx.journal.operations.get(selection.operationId), selection);
        const authority = offlineAuthority(selection, hold);
        const offline = hold.handoff.forwardRecovery.offlineSourceRecovery;
        requireConflict(offline?.requestId === authority.requestId && hold.op.status === "pending" && hold.op.startedAt === null &&
            validOriginalRestart(offline, witness, now), "Held Native offline original restart is not verified");
        await verifyOfflineReleaseCustody(tx, hold, offline);
        const source = await tx.fleetRegistry.get(authority.sourceGatewayId);
        requireConflict(source?.vm?.instanceId === witness.originalInstanceId, "Held Native original runtime changed during rollback");
        const audit = buildOperationAuditIntent({
            actor, forced: false, what: "Record the verified restart of the original Native source",
            why: "Restore the original quiesced source after alternate maintenance",
            target: { ...authority }, preActionStatus: { ...offline }, mutation: { ...witness },
            idempotencyKey: `held-native-offline-original-restored:${offline.requestId}`, now: () => now,
        });
        await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "completed", lifecycleStage: "action-completed",
            actionClaimId: offline.requestId, actionStartedAt: now, actionRecoveryCount: 0, completedAt: now, outcome: "completed" });
        await tx.fleetRegistry.patch(authority.sourceGatewayId, { vm: { ...source.vm, status: "RUNNING", stopReason: null, internalIp: witness.internalIp } }, { vmInstanceId: witness.originalInstanceId });
        await tx.gateways.roots.compareAndSetRuntimeRestartFence(authority.sourceGatewayId, offlineFence(authority.sourceGatewayId, offline), null);
        const next = { ...offline, phase: "original-restored", originalRestoredAt: witness.restartedAt };
        await tx.journal.operations.patch(hold.op.id, { schedulerHandoff: offlineHandoff(hold, next) }, { revision: hold.op.revision, status: ["pending"] });
        return authority;
    });
}
async function verifyOfflineReleaseCustody(state, hold, offline) {
    const current = await holdingCustody(state, hold, offline);
    requireConflict(current.sourceRelease === offline.sourceRelease && current.targetRelease === offline.targetRelease, "Held Native offline source or target release custody changed");
}
export async function assertHeldNativeOfflineSourceClaimable(state, op) {
    const handoff = op.schedulerHandoff;
    const recovery = handoff?.forwardRecovery;
    const offline = recovery?.offlineSourceRecovery;
    requireConflict(handoff && recovery && offline?.phase === "stopped-original" &&
        recovery.sourceReconcile === undefined && op.status === "pending" && op.startedAt === null &&
        op.completedAt === null && typeof offline.stoppedAt === "number" && Number.isSafeInteger(offline.stoppedAt) &&
        offline.stoppedAt >= offline.requestedAt, "Held Native offline source has no pending stopped-original claim");
    const selection = {
        operationId: op.id, sourceGatewayId: handoff.fromGatewayId, targetGatewayId: handoff.toGatewayId,
        sourceEpoch: recovery.sourceEpoch, schedulerMigrationId: handoff.migrationId,
    };
    const hold = journalHold(op, selection);
    requireConflict(offline.requestId === offlineRequestId(selection), "Held Native offline request changed before claim");
    await verifyOfflineReleaseCustody(state, hold, offline);
}
export async function assertPendingHeldNativeOfflineProjection(store, authority) {
    await store.transaction({ label: "held-native-return.read-offline-projection", readOnly: true }, async (tx) => {
        const hold = journalHold(await tx.journal.operations.get(authority.operationId), authority);
        requireConflict(isDeepStrictEqual(offlineAuthority(authority, hold), authority), "Held Native desired projection does not match the pending owner and operation");
        await assertHeldNativeOfflineSourceClaimable(tx, hold.op);
    });
}
async function currentOfflineClaim(tx, { authority, claimStartedAt }) {
    const hold = journalHold(await tx.journal.operations.get(authority.operationId), authority);
    const offline = hold.handoff.forwardRecovery.offlineSourceRecovery;
    requireConflict(offline?.phase === "stopped-original" && offline.requestId === authority.requestId &&
        isDeepStrictEqual(offlineAuthority(authority, hold), authority) &&
        hold.op.status === "running" && hold.op.startedAt === claimStartedAt && hold.handoff.forwardRecovery.sourceReconcile === undefined, "Held Native offline original or running claim changed");
    await verifyOfflineReleaseCustody(tx, hold, offline);
    return { hold, offline };
}
export async function assertHeldNativeOfflineSourceClaim(store, claim) {
    await store.transaction({ label: "held-native-return.read-offline-claim", readOnly: true }, tx => currentOfflineClaim(tx, claim));
}
export async function recordHeldNativeOfflineStage(store, claim, stage, now) {
    requireConflict(Number.isSafeInteger(stage.verifiedAt) && stage.verifiedAt >= claim.claimStartedAt && stage.verifiedAt <= now &&
        [stage.holdGeneration, stage.fileSha256, stage.ownerAnchorSha256].every(value => /^[a-f0-9]{64}$/.test(value)) &&
        [stage.maintenanceInstanceId, stage.immutableSnapshotId].every(value => /^[1-9]\d*$/.test(value)), "Held Native offline stage proof is unavailable");
    return store.transaction({ label: "held-native-return.record-offline-stage" }, async (tx) => {
        const { hold, offline } = await currentOfflineClaim(tx, claim);
        requireConflict(stage.maintenanceInstanceId !== offline.originalInstanceId, "Held Native offline stage used the original source");
        const next = { ...offline, phase: "staged-offline", stage };
        await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.authority.sourceGatewayId, offlineFence(claim.authority.sourceGatewayId, offline), offlineFence(claim.authority.sourceGatewayId, next));
        const schedulerHandoff = offlineHandoff(hold, next);
        await tx.journal.operations.patch(hold.op.id, {
            schedulerHandoff, status: "pending", startedAt: null, lastProgressAt: now,
            waitingOn: "held-native-offline-publication", error: { clear: true }, nextAttemptAt: { clear: true },
        }, { status: ["running"], startedAt: claim.claimStartedAt, revision: hold.op.revision });
        return schedulerHandoff;
    });
}
export function heldNativeReturnBlocksDestination(op, gatewayId) {
    const forward = op.schedulerHandoff?.forwardRecovery;
    if (gatewayId !== op.input.toGatewayId && gatewayId !== op.schedulerHandoff?.toGatewayId)
        return false;
    if (forward?.sharedTargetImportHold?.gatewayId === gatewayId)
        return true;
    if (forward?.offlineSourceRecovery)
        return true;
    if (!forward?.sourceReconcile)
        return false;
    const receipt = forward.sourceReconcile.receipt;
    return !receipt || ![Number.isSafeInteger(receipt.verifiedAt), receipt.verifiedAt >= forward.sourceReconcile.requestedAt,
        /^[a-f0-9]{16}$/.test(receipt.appliedFingerprint), /^[a-f0-9]{64}$/.test(receipt.activationManifestSha256)].every(Boolean);
}
export async function readHeldNativeReturnForTargetExclusion(state, selection) {
    const hold = journalHold(await state.journal.operations.get(selection.operationId), selection);
    const forward = hold.handoff.forwardRecovery;
    requireConflict(hold.op.status === "pending" && hold.op.startedAt === null && hold.op.completedAt === null &&
        !forward.sourceReconcile && !forward.offlineSourceRecovery && missingFingerprintAttempt(hold), "Held Native return does not admit an old target exclusion");
    requireConflict(!forward.sharedTargetImportHold || forward.sharedTargetImportHold.gatewayId === selection.targetGatewayId, "Held Native return old target authority changed");
    return { ...await holdingCustody(state, hold), uid: hold.uid, slug: hold.slug };
}
async function readSharedDrainRoster(tx, old, expected, owner, now) {
    const replacement = expected.replacementGatewayId;
    const [oldRuntime, peerRuntime, peer, oldAssignments, peerAssignments, tasks, scaler] = await Promise.all([
        tx.fleetRegistry.get(old), tx.fleetRegistry.get(replacement), tx.gateways.roots.get(replacement),
        tx.gateways.assignments.list(old), tx.gateways.assignments.list(replacement),
        tx.migrationTasks.listByStatus(["running"]), tx.controllerState.sharedPoolScaler.get(),
    ]);
    requireConflict(scaler?.replacements.some(pair => pair.sourceGatewayId === old && pair.targetGatewayId === replacement), "Exact Shared replacement pairing is unavailable");
    requireConflict(sharedDrainPodMatches(oldRuntime, expected.oldPodUid, now) && sharedDrainPodMatches(peerRuntime, expected.replacementPodUid, now), "Exact ready Shared workloads changed");
    requireConflict(peer && [peer.gatewayClass === "shared", peer.desiredStatus === "running", !peer.runtimeRestartFence, !peer.retirementClaim,
        peer.liveRelease === peer.desiredRelease, peerRuntime.release === peer.liveRelease, peerAssignments.length === 0,
        peerRuntime.heartbeat.mountedCustomers.length === 0, !peerRuntime.heartbeat.migratingIn?.length].every(Boolean), "Exact empty Shared replacement is unavailable");
    const mounted = new Set(oldRuntime.heartbeat.mountedCustomers);
    requireConflict([oldAssignments.length === expected.ownerCount, mounted.size === oldAssignments.length,
        oldAssignments.every(row => row.uid !== owner.uid && row.state === "serving" && mounted.has(row.slug)),
        !oldRuntime.heartbeat.migratingIn?.length, !tasks.some(task => task.slug === owner.slug || task.targetGatewayId === old),
    ].every(Boolean), "Old Shared roster or pending transfer changed");
    return oldAssignments.map(row => ({ uid: row.uid, slug: row.slug, epoch: row.epoch })).sort((a, b) => a.uid.localeCompare(b.uid));
}
export async function reserveNativeReturnTargetDrain(store, selection, expected, { actor, now, dryRun }) {
    const old = selection.targetGatewayId;
    const replacement = expected.replacementGatewayId;
    requireConflict(actor && old !== replacement && typeof expected.oldPodUid === "string" && typeof expected.replacementPodUid === "string" &&
        expected.oldPodUid !== expected.replacementPodUid && Number.isSafeInteger(expected.ownerCount) && expected.ownerCount > 0, "Exact Shared drain observation required");
    return store.transaction({ label: "held-native-return.reserve-target-drain", readOnly: dryRun }, async (tx) => {
        const { uid, op } = journalHold(await tx.journal.operations.get(selection.operationId), selection);
        const exclusionId = nativeReturnTargetExclusionId(uid);
        const prior = await tx.journal.audits.get(exclusionId);
        if (prior) {
            const drain = await readNativeReturnTargetDrain(tx, op);
            const recorded = prior.target.reservation;
            requireConflict(prior.actor === actor && drain && isDeepStrictEqual(recorded, { ...expected, selection, targetRelease: recorded?.targetRelease }), "A different target exclusion already exists");
            return { exclusionId, operationId: drain.operationId, oldGatewayId: old, replacementGatewayId: replacement,
                ownerCount: drain.owners.length, dormantInboundCount: drain.dormantInboundOperationIds.length };
        }
        const { slug, targetRelease } = await readHeldNativeReturnForTargetMaintenance(tx, selection);
        const [owners, active, oldRoot] = await Promise.all([
            readSharedDrainRoster(tx, old, expected, { uid, slug }, now), tx.journal.operations.listByStatus(["pending", "running"]),
            tx.gateways.roots.get(old),
        ]);
        requireConflict(oldRoot?.desiredStatus === "running", "Old Shared gateway cannot enter the drain");
        const inbound = active.filter(operation => operation.id !== selection.operationId && operation.input.toGatewayId === old);
        requireConflict(inbound.every(operation => moveHasNotBegun(operation, old)), "A second inbound move already owns Shared state");
        const drain = { operationId: selection.operationId, replacementGatewayId: replacement,
            oldPodUid: expected.oldPodUid, replacementPodUid: expected.replacementPodUid,
            owners, dormantInboundOperationIds: inbound.map(waiting => waiting.id).sort() };
        const reservation = { ...expected, selection, targetRelease };
        if (!dryRun) {
            const audit = buildOperationAuditIntent({ actor, forced: false, what: "Allow Shared owners to move past a held Native return",
                why: "Drain the old Shared gateway through ordinary migrations before compensating the held return",
                mutation: { kind: NATIVE_RETURN_TARGET_EXCLUSION, operationId: selection.operationId },
                target: { uid, targetGatewayId: old, drain, reservation }, preActionStatus: { placement: "quiescing" },
                idempotencyKey: `${NATIVE_RETURN_TARGET_EXCLUSION}:${uid}`, now: () => now });
            await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "in-progress", lifecycleStage: "action-started",
                actionClaimId: exclusionId, actionStartedAt: now, actionRecoveryCount: 0 });
            await tx.gateways.roots.patch(old, { desiredStatus: "draining", updatedAt: now, updatedBy: actor }, { revision: oldRoot.revision });
        }
        return { exclusionId, operationId: drain.operationId, oldGatewayId: old, replacementGatewayId: replacement,
            ownerCount: owners.length, dormantInboundCount: inbound.length };
    });
}
export async function isNativeReturnDrainPairProtected(state, gatewayId, side) {
    const scaler = await state.controllerState.sharedPoolScaler.get();
    const pair = scaler?.replacements.find(pair => (side === "source" ? pair.sourceGatewayId : pair.targetGatewayId) === gatewayId);
    if (!pair)
        return false;
    const operations = await state.journal.operations.listByGateway(pair.sourceGatewayId);
    for (const operation of operations) {
        if (operation.status !== "pending" || operation.input.toGatewayId !== pair.sourceGatewayId || !operation.schedulerHandoff?.forwardRecovery)
            continue;
        const drain = await readNativeReturnTargetDrain(state, operation);
        if (drain?.replacementGatewayId === pair.targetGatewayId)
            return true;
    }
    return false;
}
export async function readNativeReturnSharedDrains(state, active, now) {
    const result = [];
    const scaler = await state.controllerState.sharedPoolScaler.get();
    for (const pair of scaler?.replacements ?? []) {
        const oldGatewayId = pair.sourceGatewayId;
        const replacementGatewayId = pair.targetGatewayId;
        for (const operation of active) {
            const handoff = operation.schedulerHandoff;
            if (!handoff?.forwardRecovery || ![operation.status === "pending", operation.startedAt === null,
                operation.input.toGatewayId === oldGatewayId, handoff.forwardRecovery.phase === "source-flushed"].every(Boolean))
                continue;
            const drain = await readNativeReturnTargetDrain(state, operation);
            if (!drain || drain.replacementGatewayId !== replacementGatewayId)
                continue;
            const [old, peer] = await Promise.all([state.fleetRegistry.get(oldGatewayId), state.fleetRegistry.get(replacementGatewayId)]);
            if (!sharedDrainPodMatches(old, drain.oldPodUid, now) || !sharedDrainPodMatches(peer, drain.replacementPodUid, now))
                continue;
            try {
                const selection = { operationId: operation.id, sourceGatewayId: handoff.fromGatewayId, targetGatewayId: oldGatewayId,
                    sourceEpoch: handoff.forwardRecovery.sourceEpoch, schedulerMigrationId: handoff.migrationId };
                await holdingCustody(state, journalHold(operation, selection), undefined, { requireReady: true, allowDraining: true });
            }
            catch (error) {
                if (!(error instanceof HeldNativeReturnConflict))
                    throw error;
                continue;
            }
            const supersedableInboundOperationIds = active.filter(waiting => drain.dormantInboundOperationIds.includes(waiting.id) &&
                moveHasNotBegun(waiting, oldGatewayId)).map(waiting => waiting.id);
            result.push({ operationId: drain.operationId, oldGatewayId, replacementGatewayId, supersedableInboundOperationIds });
        }
    }
    return result;
}
export async function readHeldNativeReturnForRetiredTargetCompensation(state, selection) {
    const hold = journalHold(await state.journal.operations.get(selection.operationId), selection);
    const forward = hold.handoff.forwardRecovery;
    const exclusionId = nativeReturnTargetExclusionId(hold.uid);
    requireConflict(hold.op.status === "pending" && hold.op.startedAt === null && hold.op.completedAt === null &&
        !forward.sourceReconcile && !forward.offlineSourceRecovery && !forward.sharedTargetImportHold && missingFingerprintAttempt(hold), "Retired Shared target has no original pending Native return");
    const [drain, audit, retirement] = await Promise.all([
        readNativeReturnTargetDrain(state, hold.op), state.journal.audits.get(exclusionId), readNativeOldTargetRetirement(state, selection.targetGatewayId),
    ]);
    const reservation = audit?.target.reservation;
    requireConflict(drain && audit && retirement && reservation, "Exact Shared retirement after Native drain reservation is unavailable");
    requireConflict(typeof audit.actionStartedAt === "number" && retirement.createdAt > audit.actionStartedAt &&
        isDeepStrictEqual(selection, reservation.selection), "Shared retirement predates or differs from Native drain reservation");
    requireConflict(typeof reservation.targetRelease === "number" && typeof reservation.oldPodUid === "string", "Native drain workload binding is unavailable");
    const releases = await holdingCustody(state, hold, undefined, { retiredRelease: reservation.targetRelease });
    return { ...releases, uid: hold.uid, slug: hold.slug, exclusionId, oldPodUid: reservation.oldPodUid, retirement };
}
function sharedDepartureRoute(candidate) {
    if (![candidate.kind === "migrate-user", candidate.origin === "automatic", candidate.createdBy === "glm-controller-placement-policy",
        candidate.input.source === "continuous-placement-policy"].every(Boolean))
        return null;
    const { uid, userSlug, fromGatewayId: old, toGatewayId: replacement } = candidate.input;
    if (typeof uid !== "string" || typeof userSlug !== "string" || typeof old !== "string" || !old.startsWith("shared-") ||
        typeof replacement !== "string" || !replacement.startsWith("shared-"))
        return null;
    return { uid, userSlug, old, replacement };
}
function departureAssignmentMatches(assignments, route, epoch, operationId) {
    const assignment = assignments[0];
    if (assignments.length !== 1 || !assignment || assignment.slug !== route.userSlug)
        return false;
    if (assignment.gatewayId === route.old) {
        return assignment.epoch === epoch && (assignment.state === "serving" || assignment.updatedByOperationId === operationId);
    }
    return [assignment.gatewayId === route.replacement, assignment.epoch === epoch + 1, assignment.state === "serving",
        assignment.updatedByOperationId === operationId].every(Boolean);
}
export async function nativeReturnAllowsSharedDeparture(state, candidate, pending, now) {
    const route = sharedDepartureRoute(candidate);
    if (!route)
        return new Set();
    const { uid, userSlug, old, replacement } = route;
    for (const operation of pending) {
        if (operation.input.toGatewayId !== old || operation.schedulerHandoff?.forwardRecovery?.phase !== "source-flushed")
            continue;
        const drain = await readNativeReturnTargetDrain(state, operation);
        if (!drain || drain.replacementGatewayId !== replacement)
            continue;
        const enrollment = drain.owners.find(owner => owner.uid === uid && owner.slug === userSlug);
        if (!enrollment)
            continue;
        const [oldRuntime, peerRuntime, scaler] = await Promise.all([
            state.fleetRegistry.get(old), state.fleetRegistry.get(replacement), state.controllerState.sharedPoolScaler.get(),
        ]);
        if (!sharedDrainPodMatches(oldRuntime, drain.oldPodUid, now) || !sharedDrainPodMatches(peerRuntime, drain.replacementPodUid, now) ||
            !scaler?.replacements.some(pair => pair.sourceGatewayId === old && pair.targetGatewayId === replacement))
            continue;
        const assignments = await state.gateways.assignments.listForUid(uid);
        if (!departureAssignmentMatches(assignments, route, enrollment.epoch, candidate.id))
            continue;
        return new Set([operation.id, ...pending.filter(waiting => drain.dormantInboundOperationIds.includes(waiting.id) &&
                moveHasNotBegun(waiting, old)).map(waiting => waiting.id)]);
    }
    return new Set();
}
export async function heldNativeReturnBlocksOwnerDestination(store, gatewayId, owner) {
    if (await nativeReturnTargetDenied(store, owner.uid, gatewayId))
        return true;
    const id = owner.fences.migration?.operationId;
    if (!id)
        return false;
    const op = await store.journal.operations.get(id);
    return op !== null && heldNativeReturnBlocksDestination(op, gatewayId);
}
