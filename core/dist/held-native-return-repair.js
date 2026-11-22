import { createHash } from "node:crypto";
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
function isHeldBuilderRuntime(source, runtime, lease) {
    const allocation = source.allocation;
    return allocation?.kind === "disposable-builder" && allocation.leaseId === lease.leaseId &&
        allocation.generation === lease.generation && runtime?.runtime === "gce-vm" && runtime.vm?.status === "RUNNING";
}
async function holdingCustody(state, { op, handoff, uid, slug }) {
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
        isHeldBuilderRuntime(source, sourceRuntime, lease),
        source.desiredStatus === "running", source.liveRelease === source.desiredRelease, Number.isSafeInteger(source.liveRelease),
        source.retirementClaim == null, source.runtimeRestartFence === undefined,
        target.gatewayClass === "shared", target.desiredStatus === "running", target.liveRelease === target.desiredRelease,
        Number.isSafeInteger(target.liveRelease), target.retirementClaim == null, target.runtimeRestartFence === undefined,
        targetRuntime.heartbeat.status === "ready", !targetRuntime.heartbeat.mountedCustomers.includes(slug),
        !targetRuntime.heartbeat.migratingIn?.includes(slug),
    ].every(Boolean), "Held Native return source or target custody changed");
    const active = await state.journal.operations.listForUid(uid, { statuses: ["pending", "running"] });
    requireConflict(active.length === 1 && active[0]?.id === op.id, "A different operation holds the Native return owner");
    return { sourceRelease: source.liveRelease, targetRelease: target.liveRelease };
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
        const previous = hold.handoff.forwardRecovery.sourceReconcile;
        if (previous?.requestId !== id) {
            requireConflict(!previous && hold.op.status === "pending" && hold.op.startedAt === null && hold.op.completedAt === null &&
                missingFingerprintAttempt(hold), "Held Native return has no matching unclaimed missing-fingerprint attempt");
            const releases = await holdingCustody(tx, hold);
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
    requireConflict(marker && !marker.receipt && marker.requestId === authority.requestId &&
        observation.op.status === "running" && observation.op.startedAt === claimStartedAt &&
        observation.uid === authority.uid && observation.slug === authority.slug && requestId(authority) === marker.requestId, "Held Native return source reconcile claim changed");
    const actual = await holdingCustody(state, observation);
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
export function heldNativeReturnBlocksDestination(op, gatewayId) {
    const forward = op.schedulerHandoff?.forwardRecovery;
    if (!forward?.sourceReconcile || (gatewayId !== op.input.toGatewayId && gatewayId !== op.schedulerHandoff?.toGatewayId))
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
