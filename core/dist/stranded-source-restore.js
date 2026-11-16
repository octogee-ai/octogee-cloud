import { isDeepStrictEqual } from "node:util";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { MigrationRpcError } from "./fleet-migration-client.js";
import { restoreScheduleTransfer } from "./fleet-migration-runner.js";
import { markAssignmentStateInTransaction } from "./fleet-state.js";
import { PlacementPreconditionFailed } from "./placement-refusal.js";
const MIGRATE_USER_KIND = "migrate-user";
const SOURCE_HELD_STEP = "quiesce-source";
const TARGET_UNMOUNTED_STEP = "rollback:unmount-target";
const INGRESS_RESUMED_STEP = "rollback:resume-ingress";
const ROLLBACK_STEP_PREFIX = "rollback:";
const STORE_HANDOFF_STEP = "final-sync-state";
const FAILURES_BEFORE_STORE_HANDOFF = new Set([SOURCE_HELD_STEP, "flush-source"]);
const NOT_STRANDED = "source-not-stranded";
const IN_FLIGHT = "migration-in-flight";
const NOT_PROVEN = "rollback-not-proven";
const STATE_CHANGED = "fleet-state-changed";
const ACCOUNT_NOT_ACTIVE = "account-not-active";
const SOURCE_RETIRED = "source-gateway-retired";
export class StrandedSourceResumeFailed extends Error {
    gatewayId;
    operationId;
    gatewayAnswered;
    constructor(source, cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        super(`source ingress on ${source.gatewayId} not resumed for ${source.slug}: ${reason}`, { cause });
        this.name = "StrandedSourceResumeFailed";
        this.gatewayId = source.gatewayId;
        this.operationId = source.operationId;
        this.gatewayAnswered = cause instanceof MigrationRpcError;
    }
}
function firstRefusal(checks) {
    const refused = checks.find(([failed]) => failed);
    return refused ? [refused[1], refused[2]] : null;
}
function refuse([reasonCode, message]) {
    throw new PlacementPreconditionFailed(reasonCode, message);
}
function rollbackLeftSourceClosed(steps) {
    if (steps.length < 3)
        return false;
    const [failed, unmount, resume] = steps.slice(-3);
    const completed = steps.slice(0, -3);
    return [
        unmount.name === TARGET_UNMOUNTED_STEP && unmount.status === "done",
        resume.name === INGRESS_RESUMED_STEP && (resume.status === "failed" || resume.status === "done"),
        failed.status === "failed" && FAILURES_BEFORE_STORE_HANDOFF.has(failed.name),
        completed.every((step) => step.status === "done" && !step.name.startsWith(ROLLBACK_STEP_PREFIX)),
        steps.filter((step) => step.name === SOURCE_HELD_STEP).length === 1,
        new Set(steps.map((step) => step.name)).size === steps.length,
    ].every(Boolean);
}
function gatewayRefusal(root, stranded) {
    if (root === null)
        return [SOURCE_RETIRED, `gateway ${stranded.gatewayId} has no root; its ingress cannot be resumed`];
    if (root.desiredStatus === "retired")
        return [SOURCE_RETIRED, `gateway ${stranded.gatewayId} is retired; its ingress cannot be resumed`];
    return null;
}
function earlierAttempts(operation) {
    const history = operation.attemptHistory ?? [];
    return history.at(-1)?.attempt === operation.attempts ? history.slice(0, -1) : history;
}
function leftRollbackUnfinished(attempt) {
    if (!Array.isArray(attempt.steps))
        return true;
    const rollback = attempt.steps.filter((step) => step.name.startsWith(ROLLBACK_STEP_PREFIX));
    const handedStoresOff = attempt.steps.some((step) => step.name === STORE_HANDOFF_STEP);
    return rollback.some((step) => step.status !== "done") ||
        handedStoresOff && !rollback.some((step) => step.name === INGRESS_RESUMED_STEP);
}
function userRefusal(user, stranded, others) {
    const { uid } = user;
    const marker = readWorkspaceMigrationMarker({ migration: user.fences.migration });
    const fenceOwner = marker?.operationId ?? "no operation";
    return firstRefusal([
        [!accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined }), ACCOUNT_NOT_ACTIVE,
            `user ${uid} account is ${user.accountLifecycle?.status ?? "not active"}; it is not served`],
        [user.fences.restoreFence !== undefined, STATE_CHANGED, `user ${uid} restore outcome is unresolved`],
        [user.fences.sourceTransferFence !== undefined, STATE_CHANGED, `user ${uid} source transfer outcome is unresolved`],
        [user.gateway?.gatewayId !== stranded.gatewayId, STATE_CHANGED,
            `user ${uid} is assigned to ${user.gateway?.gatewayId ?? "no gateway"}, not to ${stranded.gatewayId} where its assignment is quiescing`],
        [others.length > 0, STATE_CHANGED, `user ${uid} also holds an assignment on ${others.map((other) => other.gatewayId).join(", ")}`],
        [user.slug !== stranded.slug, STATE_CHANGED, `user ${uid} is ${user.slug ?? "unnamed"}, but its assignment on ${stranded.gatewayId} is for ${stranded.slug}`],
        [user.fences.migration !== undefined && marker?.operationId !== stranded.updatedByOperationId, STATE_CHANGED,
            `user ${uid} migration fence names ${fenceOwner}, not ${stranded.updatedByOperationId}`],
    ]);
}
function moveInput(operation) {
    const { uid, userSlug, fromGatewayId, toGatewayId, recoverSourceOnly } = operation.input;
    return { uid, userSlug, fromGatewayId, toGatewayId, recoverSourceOnly };
}
function movesUserOutOf(operation, stranded) {
    const input = moveInput(operation);
    return [
        operation.kind === MIGRATE_USER_KIND,
        input.uid === stranded.uid,
        input.userSlug === undefined || input.userSlug === stranded.slug,
        input.fromGatewayId === stranded.gatewayId,
        typeof input.toGatewayId === "string" && input.toGatewayId !== "" && input.toGatewayId !== stranded.gatewayId,
    ].every(Boolean);
}
function ownerRefusal(operation, stranded) {
    const operationId = stranded.updatedByOperationId;
    if (operation === null)
        return [NOT_PROVEN, `operation ${operationId} that closed ${stranded.gatewayId} is not in the journal`];
    return firstRefusal([
        [!movesUserOutOf(operation, stranded), NOT_STRANDED, `operation ${operationId} is not a user move of ${stranded.uid} out of ${stranded.gatewayId}`],
        [operation.status === "pending" || operation.status === "running", IN_FLIGHT, `operation ${operationId} is ${operation.status}`],
        [operation.status !== "failed", NOT_PROVEN, `operation ${operationId} is ${operation.status}, not failed`],
    ]);
}
function forwardStateRefusal(operation, stranded) {
    const { id } = operation;
    return firstRefusal([
        [operation.cutoverCommittedAt !== undefined, NOT_PROVEN, `operation ${id} committed its cutover`],
        [operation.userMigrationV2 !== undefined, NOT_PROVEN, `operation ${id} holds forward migration state`],
        [operation.schedulerHandoff?.forwardRecovery !== undefined, NOT_PROVEN, `operation ${id} holds a forward recovery checkpoint`],
        [operation.sourceTransferExecution !== undefined, NOT_PROVEN, `operation ${id} holds a source transfer`],
        [operation.cancellationRequestedAt !== undefined, NOT_PROVEN, `operation ${id} has a cancellation pending`],
        [moveInput(operation).recoverSourceOnly === true, NOT_PROVEN, `operation ${id} is a source-only recovery`],
        [stranded.sharedSurgeForwardRecovery !== undefined, NOT_PROVEN,
            `the assignment of ${stranded.uid} on ${stranded.gatewayId} carries a forward recovery marker`],
        [!Array.isArray(operation.steps) || !rollbackLeftSourceClosed(operation.steps), NOT_PROVEN,
            `the recorded steps of operation ${id} do not show its target unmounted and its source ingress left to resume`],
        [earlierAttempts(operation).some(leftRollbackUnfinished), NOT_PROVEN, `an earlier attempt of operation ${id} did not finish its rollback`],
    ]);
}
function inFlightRefusal(active, stranded) {
    const blocking = active.find((operation) => {
        const input = operation.input;
        return operation.inputUid === stranded.uid || input.uid === stranded.uid || input.gatewayId === stranded.gatewayId;
    });
    return blocking ? [IN_FLIGHT, `${blocking.kind} operation ${blocking.id} is ${blocking.status}`] : null;
}
function quiescingAssignment(uid, assignments) {
    const quiescing = assignments.filter((assignment) => assignment.state === "quiescing");
    if (quiescing.length === 0)
        refuse([NOT_STRANDED, `user ${uid} has no quiescing assignment; nothing to restore`]);
    if (quiescing.length > 1) {
        refuse([STATE_CHANGED, `user ${uid} is quiescing on ${quiescing.map((assignment) => assignment.gatewayId).join(", ")}`]);
    }
    const [stranded] = quiescing;
    if (!stranded.updatedByOperationId) {
        refuse([NOT_STRANDED, `the quiescing assignment of ${uid} on ${stranded.gatewayId} names no operation`]);
    }
    return stranded;
}
async function inspectStrandedSource(tx, uid) {
    const [user, assignments] = await Promise.all([
        tx.users.records.get(uid),
        tx.gateways.assignments.listForUid(uid),
    ]);
    if (user === null)
        refuse(["user-missing", `user ${uid} does not exist`]);
    const stranded = quiescingAssignment(uid, assignments);
    const operationId = stranded.updatedByOperationId;
    const [operation, active, root] = await Promise.all([
        tx.journal.operations.get(operationId),
        tx.journal.operations.listByStatus(["pending", "running"]),
        tx.gateways.roots.get(stranded.gatewayId),
    ]);
    const refusal = ownerRefusal(operation, stranded)
        ?? forwardStateRefusal(operation, stranded)
        ?? gatewayRefusal(root, stranded)
        ?? userRefusal(user, stranded, assignments.filter((assignment) => assignment !== stranded))
        ?? inFlightRefusal(active.filter((candidate) => candidate.id !== operationId), stranded);
    if (refusal !== null)
        refuse(refusal);
    return {
        source: {
            uid,
            slug: stranded.slug,
            gatewayId: stranded.gatewayId,
            epoch: stranded.epoch,
            assignmentUpdatedAt: stranded.updatedAt,
            operationId,
            targetGatewayId: moveInput(operation).toGatewayId,
        },
        sourceDraining: root.desiredStatus === "draining",
    };
}
export function readStrandedSource(store, uid) {
    return store.transaction({ label: "stranded-source.read", readOnly: true }, async (tx) => (await inspectStrandedSource(tx, uid)).source);
}
async function markSourceServing(deps, source) {
    const now = deps.now ? deps.now().getTime() : Date.now();
    return deps.store.transaction({ label: "stranded-source.restore-serving" }, async (tx) => {
        const current = await inspectStrandedSource(tx, source.uid);
        if (!isDeepStrictEqual(current.source, source)) {
            refuse([STATE_CHANGED, `the quiescing assignment of ${source.uid} on ${source.gatewayId} changed while its ingress resumed`]);
        }
        await markAssignmentStateInTransaction(tx, {
            gatewayId: source.gatewayId,
            uid: source.uid,
            slug: source.slug,
            epoch: source.epoch,
            state: "serving",
            updatedByOperationId: source.operationId,
            expected: { state: "quiescing", updatedByOperationId: source.operationId, updatedAt: source.assignmentUpdatedAt },
        }, now);
        return current;
    });
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
async function restoreSchedules(deps, source) {
    const { uid, slug, gatewayId, operationId } = source;
    const unrestored = (reason) => {
        deps.log(`[stranded-source] ❌ the schedules operation ${operationId} took off ${gatewayId} were not restored for uid=${uid} slug=${slug}: ${reason}; ` +
            `the source is restored without them`);
        return false;
    };
    try {
        const restored = await deps.restoreSourceSchedules({ uid, operationId, gatewayId, slug });
        return restored === false ? unrestored("the gateway did not restore every schedule") : restored;
    }
    catch (error) {
        return unrestored(errorText(error));
    }
}
export async function restoreStrandedSourceServing(deps, expected) {
    const { uid, slug, gatewayId, operationId, targetGatewayId } = expected;
    const source = await readStrandedSource(deps.store, uid);
    if (!isDeepStrictEqual(source, expected)) {
        refuse([STATE_CHANGED, `the quiescing assignment of ${uid} is no longer the one on ${gatewayId} left by operation ${operationId}`]);
    }
    try {
        await deps.resumeSourceIngress({ operationId, gatewayId, slug });
    }
    catch (cause) {
        const failure = new StrandedSourceResumeFailed(source, cause);
        deps.log(`[stranded-source] ❌ ${failure.message}; uid=${uid} stays quiescing under operation ${operationId}`);
        throw failure;
    }
    const schedulesRestored = await restoreSchedules(deps, source);
    let sourceDraining;
    try {
        ({ sourceDraining } = await markSourceServing(deps, source));
    }
    catch (error) {
        deps.log(`[stranded-source] ❌ source ingress on ${gatewayId} resumed but the assignment was not restored for uid=${uid} slug=${slug}: ${errorText(error)}`);
        throw error;
    }
    deps.log(`[stranded-source] restored serving for uid=${uid} slug=${slug} on ${gatewayId} after operation ${operationId} left it quiescing`);
    if (sourceDraining) {
        deps.log(`[stranded-source] ⚠ uid=${uid} slug=${slug} serves again on ${gatewayId}, which is draining; ` +
            `operation ${operationId} stays failed and is not re-armed, so the user needs an operator move off ${gatewayId}`);
    }
    return { uid, slug, gatewayId, operationId, targetGatewayId, state: "serving", schedulesRestored, sourceDraining };
}
export function strandedSourceRestoreOutcome(restored) {
    if (restored.schedulesRestored !== false)
        return { outcome: "completed" };
    return {
        outcome: "partial",
        partialOutcome: {
            summary: `${restored.slug} serves again on ${restored.gatewayId}; its schedules were not restored`,
            details: { schedulesRestored: false },
        },
    };
}
export function strandedSourceGatewayCalls(deps) {
    return {
        resumeSourceIngress: async ({ operationId, gatewayId, slug }) => {
            const client = await deps.clientFor(gatewayId);
            await client.resume({ migrationId: deps.migrationIdFor(operationId), gatewayId, slug });
        },
        restoreSourceSchedules: async ({ uid, operationId, gatewayId, slug }) => {
            const migrationId = deps.migrationIdFor(operationId);
            const transfer = await deps.store.users.scheduleTransfers.get(uid, migrationId);
            if (transfer === null)
                return "none";
            if (transfer.restoredTo !== undefined)
                return true;
            const failures = await restoreScheduleTransfer({
                client: await deps.clientFor(gatewayId),
                log: deps.log,
                ...(deps.now ? { now: deps.now } : {}),
                readScheduleTransfer: async () => transfer,
                recordScheduleRestore: (id, restore) => deps.store.users.scheduleTransfers.patch(uid, id, restore),
            }, { migrationId, slug, gatewayId, doc: transfer });
            return failures.length === 0;
        },
    };
}
