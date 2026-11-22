import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
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
    return [target.gatewayClass === "shared", target.desiredStatus === "running", targetReleaseMatches(target, check?.release),
        Number.isSafeInteger(target.liveRelease), target.retirementClaim == null, isDeepStrictEqual(target.runtimeRestartFence, check?.fence),
        heldReturnTargetHeartbeatMatches(runtime.heartbeat, slug, check?.requireReady ?? true)].every(Boolean);
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
    requireConflict(user && lease && marker && source && target && assignment && targetRuntime, "Held Native return custody cannot be verified");
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
        targetHoldsReturn(target, targetRuntime, slug, targetCheck),
    ].every(Boolean), "Held Native return source or target custody changed");
    const active = await state.journal.operations.listForUid(uid, { statuses: ["pending", "running"] });
    requireConflict(active.length === 1 && active[0]?.id === op.id, "A different operation holds the Native return owner");
    return { sourceRelease: source.liveRelease, targetRelease: target.liveRelease, originalInstanceId: sourceRuntime?.vm?.instanceId };
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
        await tx.journal.operations.patch(hold.op.id, { schedulerHandoff }, { status: ["running"], startedAt: claim.claimStartedAt, revision: hold.op.revision });
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
export async function heldNativeReturnBlocksOwnerDestination(store, gatewayId, owner) {
    const id = owner.fences.migration?.operationId;
    if (!id)
        return false;
    const op = await store.journal.operations.get(id);
    return op !== null && heldNativeReturnBlocksDestination(op, gatewayId);
}
