import { isDeepStrictEqual } from "node:util";
import { resolveUserGatewayControlState, readSchedulerMigrationIdentity, } from "@octogee/shared/types/glm";
import { hasFreshReadyKubernetesObservation, isGatewayRuntimeDoc, projectGatewayDesiredRootForGateway, } from "@octogee/shared/types/gateway-releases";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { userMigrationV2GatewayRootFenceEqual, userMigrationV2GatewayRootFenceMatches, } from "./user-migration-v2.js";
import { builderActivateOperationId, withCurrentSizingKey, } from "./user-activation-lease.js";
import { gatewayAuthorizationFromRootDocument } from "./gateway-live-release.js";
import { MalformedRecordError } from "./platform-state/index.js";
const MIGRATE_USER_OPERATION_KIND = "migrate-user";
const CLEAR = { clear: true };
function nowMs(deps) {
    return deps.now ? deps.now().getTime() : Date.now();
}
function recordOrEmpty(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}
function withoutRevision(record) {
    if (record === null)
        return undefined;
    const { revision: _revision, ...data } = record;
    return data;
}
function runtimeDocument(record) {
    const data = withoutRevision(record);
    return data === undefined ? undefined : { docKind: "runtime", ...data };
}
function operationData(record) {
    return record === null ? undefined : record;
}
function migrationMarker(user) {
    return readWorkspaceMigrationMarker({ migration: user?.fences.migration });
}
function activationLeaseView(user) {
    return { activationLease: user?.activationLease ?? undefined };
}
function interactiveAccess(user) {
    return accountAllowsInteractiveAccess({ accountLifecycle: user?.accountLifecycle ?? undefined });
}
function assertRestoreUnfenced(user) {
    if (user?.fences.restoreFence !== undefined)
        throw new Error("user restore outcome is unresolved");
    if (user?.fences.sourceTransferFence !== undefined)
        throw new Error("user source transfer outcome is unresolved");
}
async function clearWorkspaceMigrationMarker(tx, user, uid) {
    await tx.users.records.setFence(uid, "migration", CLEAR, user?.fences.migration ?? "absent");
}
function workspaceMigrationMarker(operationId, startedAt) {
    return { state: "moving", startedAt, ...(operationId ? { operationId } : {}) };
}
export async function setWorkspaceMigrationPhase(deps, params) {
    const startedAt = nowMs(deps);
    const { phase } = params;
    const state = phase === "preparing" || phase === "waiting" ? "preparing" : "moving";
    const progress = phase === "activating" || phase === "checkpointing" ? { phase: "transferring", activity: phase } : { phase };
    await deps.store.transaction({ label: "fleet-state.setWorkspaceMigrationPhase" }, async (tx) => {
        const [user, stored] = await Promise.all([
            tx.users.records.get(params.uid),
            tx.journal.operations.get(params.operationId),
        ]);
        assertRestoreUnfenced(user);
        const operation = recordOrEmpty(stored);
        const input = recordOrEmpty(operation.input);
        const prior = migrationMarker(user);
        const expectedGateway = params.phase === "connecting" && typeof operation.cutoverCommittedAt === "number"
            ? input.toGatewayId : params.sourceGatewayId;
        const exact = [
            user !== null, stored !== null,
            operation.kind === "migrate-user", operation.status === "running",
            operation.cancellationRequestedAt === undefined || migrationCancellationDeferred(operation, params.operationId), input.uid === params.uid,
            input.fromGatewayId === params.sourceGatewayId, user?.gateway?.gatewayId === expectedGateway,
            !prior?.operationId || prior.operationId === params.operationId,
        ].every(Boolean);
        if (!exact)
            throw new Error("workspace migration phase authority changed");
        await tx.users.records.setFence(params.uid, "migration", {
            state, ...progress,
            operationId: params.operationId,
            startedAt: prior?.startedAt ?? startedAt,
        }, user?.fences.migration ?? "absent");
    });
}
export async function assertWorkspaceMigrationSourcePreparationAuthority(deps, params) {
    if (![params.uid, params.slug, params.sourceGatewayId, params.targetGatewayId, params.operationId].every(value => typeof value === "string" && value.length > 0 && !value.includes("/")) ||
        params.sourceGatewayId === params.targetGatewayId || !Number.isSafeInteger(params.sourceEpoch) || params.sourceEpoch < 0 ||
        !Number.isSafeInteger(params.claimStartedAt) || params.claimStartedAt <= 0) {
        throw new Error("workspace migration source preparation identity is invalid");
    }
    await deps.store.transaction({ label: "fleet-state.assertWorkspaceMigrationSourcePreparationAuthority", readOnly: true }, async (tx) => {
        const [user, stored, source, storedSourceRoot, target, storedTargetRoot, targetRuntime] = await Promise.all([
            tx.users.records.get(params.uid),
            tx.journal.operations.get(params.operationId),
            tx.gateways.assignments.get(params.sourceGatewayId, params.uid),
            tx.gateways.roots.get(params.sourceGatewayId),
            tx.gateways.assignments.get(params.targetGatewayId, params.uid),
            tx.gateways.roots.get(params.targetGatewayId),
            tx.fleetRegistry.get(params.targetGatewayId),
        ]);
        assertRestoreUnfenced(user);
        const marker = migrationMarker(user);
        const operation = recordOrEmpty(stored);
        const input = recordOrEmpty(operation.input);
        const sourceRoot = projectGatewayDesiredRootForGateway(withoutRevision(storedSourceRoot), params.sourceGatewayId);
        const targetRoot = projectGatewayDesiredRootForGateway(withoutRevision(storedTargetRoot), params.targetGatewayId);
        const exact = [
            user !== null, stored !== null,
            user?.gateway?.gatewayId === params.sourceGatewayId, user?.slug === params.slug,
            sourcePreparationJournalCurrent(params, marker, operation, input),
            preparationAssignmentMatches(params, source), source?.slug === params.slug,
            sourceRoot?.gatewayClass === "shared", sourceRoot?.desiredStatus === "running" || sourceRoot?.desiredStatus === "draining",
            storedSourceRoot?.runtimeRestartFence === undefined,
            storedTargetRoot?.runtimeRestartFence === undefined,
            targetRoot?.desiredStatus === "running", target === null,
            sourcePreparationAttemptClean(operation, params), sourcePreparationTargetUnadmitted(runtimeDocument(targetRuntime), params),
        ].every(Boolean);
        if (!exact)
            throw new Error("workspace migration source preparation authority changed");
        assertRecoveryTarget({
            operationId: params.operationId, input, openclaw: activationLeaseView(user), sourceEpoch: params.sourceEpoch,
            targetRoot: withoutRevision(storedTargetRoot), schedulerHandoff: undefined,
        });
    });
}
function sourcePreparationJournalCurrent(params, marker, operation, input) {
    return [
        marker?.operationId === params.operationId, marker?.state === "preparing", marker?.phase === "preparing",
        operation.kind === MIGRATE_USER_OPERATION_KIND, operation.status === "running", operation.startedAt === params.claimStartedAt,
        operation.cancellationRequestedAt === undefined, operation.cutoverCommittedAt === undefined,
        operation.userMigrationV2 === undefined, operation.sourceTransferExecution === undefined,
        operation.restoreAttempt === undefined,
        operation.schedulerHandoffLost === undefined, input.recoverSourceOnly !== true, input.sourceTransferMode === undefined,
        input.uid === params.uid, input.fromGatewayId === params.sourceGatewayId, input.toGatewayId === params.targetGatewayId,
        input.userSlug === undefined || input.userSlug === params.slug,
    ].every(Boolean);
}
function sourcePreparationAttemptClean(operation, params) {
    if (!Array.isArray(operation.steps) || operation.steps.length !== 0)
        return false;
    if (operation.schedulerHandoff === undefined)
        return operation.schedulerHandoffReleased === undefined && operation.schedulerHandoffReleasedAt === undefined;
    const handoff = recordOrEmpty(operation.schedulerHandoff);
    const identity = readSchedulerMigrationIdentity(params.operationId, handoff.migrationId);
    return [
        operation.schedulerHandoffReleased === true,
        Number.isSafeInteger(operation.schedulerHandoffReleasedAt),
        identity !== null && identity.claimStartedAt < params.claimStartedAt,
        identity !== null && Number(operation.schedulerHandoffReleasedAt) >= identity.claimStartedAt,
        handoff.uid === params.uid, handoff.slug === params.slug,
        handoff.fromGatewayId === params.sourceGatewayId, handoff.toGatewayId === params.targetGatewayId,
    ].every(Boolean);
}
function sourcePreparationTargetUnadmitted(runtime, params) {
    if (runtime === undefined)
        return true;
    const heartbeat = recordOrEmpty(runtime.heartbeat);
    return isGatewayRuntimeDoc(runtime) && runtime.gatewayId === params.targetGatewayId &&
        Array.isArray(heartbeat.mountedCustomers) && !heartbeat.mountedCustomers.includes(params.slug) &&
        Array.isArray(heartbeat.migratingIn) && !heartbeat.migratingIn.includes(params.slug);
}
export async function assertWorkspaceMigrationRecoveryAuthority(deps, params) {
    await workspaceMigrationRecovery(deps, params, false);
}
export function userActivationRecoveryTargetMatches(params) {
    const { input, openclaw } = params;
    const lease = recordOrEmpty(openclaw.activationLease);
    const root = recordOrEmpty(params.targetRoot);
    const allocation = recordOrEmpty(root.allocation);
    const generationValid = Number.isSafeInteger(lease.generation) && Number(lease.generation) > 0;
    return [
        params.operationId === (generationValid && typeof input.toGatewayId === "string" && input.toGatewayId !== ""
            ? builderActivateOperationId(input.toGatewayId, lease.generation)
            : null),
        input.source === "builder-activation-lease",
        root.gatewayClass === "isolated", root.gatewayId === input.toGatewayId, root.ownerUid === input.uid,
        allocation.kind === "disposable-builder", allocation.claimedByUid === input.uid,
        typeof lease.leaseId === "string", lease.leaseId !== "", allocation.leaseId === lease.leaseId,
        Number.isSafeInteger(lease.generation), Number(lease.generation) > 0, allocation.generation === lease.generation,
        lease.status === "activating" || lease.status === "failed",
        lease.sourceGatewayId === input.fromGatewayId, lease.sourceAssignmentEpoch === params.sourceEpoch,
        lease.targetGatewayId === input.toGatewayId,
    ].every(Boolean);
}
export async function completeWorkspaceMigrationRecovery(deps, params) {
    await workspaceMigrationRecovery(deps, params, true);
}
export function sharedRecoveryTargetCleaned(input, schedulerHandoff) {
    if (input.recoverSourceOnly !== true || input.source === "builder-activation-lease")
        return false;
    const steps = recordOrEmpty(recordOrEmpty(schedulerHandoff).sourceRecovery).steps;
    if (!Array.isArray(steps))
        return false;
    return steps.some(value => {
        const step = recordOrEmpty(value);
        return step.name === "rollback:unmount-target" && step.status === "done";
    });
}
export function isolatedTargetBelongsToUser(targetRoot, input) {
    const root = projectGatewayDesiredRootForGateway(targetRoot, String(input.toGatewayId));
    return root?.gatewayClass === "isolated" && typeof input.uid === "string" && root.ownerUid === input.uid &&
        root.allocation?.kind === "disposable-builder" && root.allocation.claimedByUid === input.uid;
}
function assertRecoveryTarget(params) {
    const matches = params.input.source === "builder-activation-lease"
        ? userActivationRecoveryTargetMatches(params)
        : sharedRecoveryTargetCleaned(params.input, params.schedulerHandoff) ||
            projectGatewayDesiredRootForGateway(params.targetRoot, String(params.input.toGatewayId))?.gatewayClass === "shared" ||
            isolatedTargetBelongsToUser(params.targetRoot, params.input);
    if (!matches)
        throw new Error("workspace migration recovery target authority changed");
}
async function workspaceMigrationRecovery(deps, params, complete) {
    const completedAt = nowMs(deps);
    const label = complete ? "fleet-state.completeWorkspaceMigrationRecovery" : "fleet-state.assertWorkspaceMigrationRecoveryAuthority";
    await deps.store.transaction({ label, readOnly: !complete }, async (tx) => {
        const [user, stored, source, sourceRoot] = await Promise.all([
            tx.users.records.get(params.uid),
            tx.journal.operations.get(params.operationId),
            tx.gateways.assignments.get(params.sourceGatewayId, params.uid),
            tx.gateways.roots.get(params.sourceGatewayId),
        ]);
        assertRestoreUnfenced(user);
        const operation = recordOrEmpty(stored);
        const input = recordOrEmpty(operation.input);
        const handoff = recordOrEmpty(operation.schedulerHandoff);
        const exact = [
            recoveryIntentMatches(params, input, handoff),
            operation.kind === MIGRATE_USER_OPERATION_KIND, operation.status === "running",
            operation.startedAt === params.claimStartedAt, Number.isFinite(params.claimStartedAt), params.claimStartedAt > 0,
            operation.cutoverCommittedAt === undefined, operation.userMigrationV2 === undefined,
            operation.cancellationRequestedAt === undefined,
            input.uid === params.uid, input.fromGatewayId === params.sourceGatewayId,
            typeof input.toGatewayId === "string", input.toGatewayId !== params.sourceGatewayId,
            recoverySourceCurrent(params, user, source),
            projectGatewayDesiredRootForGateway(withoutRevision(sourceRoot), params.sourceGatewayId)?.gatewayClass === "shared",
        ].every(Boolean);
        if (!exact)
            throw new Error("workspace migration recovery authority changed");
        const [target, targetRoot] = await Promise.all([
            tx.gateways.assignments.get(String(input.toGatewayId), params.uid),
            tx.gateways.roots.get(String(input.toGatewayId)),
        ]);
        if (target !== null)
            throw new Error("workspace migration recovery target assignment remains");
        assertRecoveryTarget({
            operationId: params.operationId, input, openclaw: activationLeaseView(user), sourceEpoch: params.sourceEpoch,
            targetRoot: withoutRevision(targetRoot), schedulerHandoff: handoff,
        });
        if (!complete)
            return;
        await tx.gateways.assignments.patch(params.sourceGatewayId, params.uid, { state: "serving", updatedByOperationId: params.operationId, updatedAt: completedAt }, { epoch: params.sourceEpoch });
        await tx.journal.operations.patch(params.operationId, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: completedAt }, { status: ["running"], startedAt: params.claimStartedAt });
        await clearWorkspaceMigrationMarker(tx, user, params.uid);
    });
}
function recoveryIntentMatches(params, input, handoff) {
    if (input.recoverSourceOnly !== true)
        return true;
    const recovery = recordOrEmpty(handoff.sourceRecovery);
    return [
        handoff.uid === params.uid, handoff.fromGatewayId === params.sourceGatewayId, handoff.toGatewayId === input.toGatewayId,
        readSchedulerMigrationIdentity(params.operationId, handoff.migrationId) !== null, recovery.migrationId === handoff.migrationId,
        recovery.sourceEpoch === params.sourceEpoch, Array.isArray(recovery.steps),
    ].every(Boolean);
}
function recoverySourceCurrent(params, user, source) {
    if (source === null)
        return false;
    const marker = migrationMarker(user);
    const ownedBySource = source.updatedByOperationId === params.operationId;
    return [
        user?.gateway?.gatewayId === params.sourceGatewayId,
        marker?.operationId === params.operationId ||
            user?.fences.migration === undefined && source.state === "serving" && ownedBySource,
        source.uid === params.uid, source.gatewayId === params.sourceGatewayId, source.epoch === params.sourceEpoch,
        Number.isSafeInteger(params.sourceEpoch), params.sourceEpoch >= 0,
        source.state === "serving" || source.state === "quiescing" && ownedBySource,
    ].every(Boolean);
}
function preparationAssignmentMatches(params, source) {
    return source !== null && source.uid === params.uid && source.gatewayId === params.sourceGatewayId &&
        source.state === "serving" && Number.isSafeInteger(params.sourceEpoch) && params.sourceEpoch >= 0 &&
        source.epoch === params.sourceEpoch;
}
async function preparationSourceMatches(tx, params, source) {
    if (params.sourceAssignmentMode === "assigned")
        return preparationAssignmentMatches(params, source);
    if (params.sourceAssignmentMode !== "unassigned-live" || source !== null || params.sourceEpoch !== 0 ||
        !Number.isSafeInteger(params.sourceRelease) || params.sourceRelease < 1 ||
        !Number.isFinite(params.sourceRootUpdatedAt))
        return false;
    const stored = await tx.gateways.roots.get(params.sourceGatewayId);
    const root = gatewayAuthorizationFromRootDocument(withoutRevision(stored), params.sourceGatewayId)?.gateway;
    return root !== undefined && root.desiredStatus === "running" &&
        root.desiredRelease === params.sourceRelease && root.liveRelease === params.sourceRelease &&
        root.updatedAt === params.sourceRootUpdatedAt;
}
export async function clearWorkspaceMigrationPreparation(deps, params) {
    await deps.store.transaction({ label: "fleet-state.clearWorkspaceMigrationPreparation" }, async (tx) => {
        const [user, stored, source] = await Promise.all([
            tx.users.records.get(params.uid),
            tx.journal.operations.get(params.operationId),
            tx.gateways.assignments.get(params.sourceGatewayId, params.uid),
        ]);
        assertRestoreUnfenced(user);
        const marker = migrationMarker(user);
        const operation = recordOrEmpty(stored);
        const input = recordOrEmpty(operation.input);
        const exact = [
            user !== null, stored !== null,
            marker?.state === "preparing", marker?.operationId === params.operationId,
            user?.gateway?.gatewayId === params.sourceGatewayId,
            input.uid === params.uid, input.fromGatewayId === params.sourceGatewayId,
            typeof input.toGatewayId === "string", input.toGatewayId !== params.sourceGatewayId,
            await preparationSourceMatches(tx, params, source),
            preparationCleanupMatches(operation, marker?.phase),
        ].every(Boolean);
        if (!exact)
            throw new Error("workspace preparation cleanup authority changed");
        const target = await tx.gateways.assignments.get(String(input.toGatewayId), params.uid);
        if (target !== null)
            throw new Error("workspace preparation target assignment remains");
        await clearWorkspaceMigrationMarker(tx, user, params.uid);
    });
}
function transferringRollbackConfirmed(operation) {
    const steps = operation.steps.map(recordOrEmpty);
    const once = (name, statuses) => {
        const matches = steps.filter(step => step.name === name);
        return matches.length === 1 && statuses.includes(String(matches[0]?.status));
    };
    return once("quiesce-source", ["done"]) &&
        (once("final-sync-state", ["failed"]) || once("verify-target", ["failed"])) &&
        once("rollback:unmount-target", ["done"]) && once("rollback:resume-ingress", ["done"]);
}
function preparationCleanupMatches(operation, phase) {
    if (phase === "preparing" && preparationStepsMatch(operation, "done"))
        return true;
    if (operation.kind !== MIGRATE_USER_OPERATION_KIND ||
        !["running", "failed"].includes(String(operation.status)) ||
        operation.cutoverCommittedAt !== undefined || operation.userMigrationV2 !== undefined ||
        operation.cancellationRequestedAt !== undefined || !Array.isArray(operation.steps))
        return false;
    if (phase === "transferring" || phase === "connecting") {
        return transferringRollbackConfirmed(operation);
    }
    if (phase !== "preparing" && phase !== "waiting")
        return false;
    const steps = operation.steps.map(value => {
        const step = recordOrEmpty(value);
        return [step.name, step.status];
    });
    if (phase === "preparing")
        return steps.length === 0 || isDeepStrictEqual(steps, [["keys-sync-state", "failed"]]);
    return isDeepStrictEqual(steps, [
        ["keys-sync-state", "done"], ["pre-sync-state", "done"],
        ["wait-for-active-work", "failed"], ["rollback:unmount-target", "done"],
    ]);
}
export async function clearRetiredUserActivationPreparation(deps, params) {
    const operationId = builderActivateOperationId(params.targetGatewayId, params.generation);
    return deps.store.transaction({ label: "fleet-state.clearRetiredBuilderActivationPreparation" }, async (tx) => {
        const [user, stored, storedTargetRoot, storedRetirement, targetAssignment] = await Promise.all([
            tx.users.records.get(params.uid),
            tx.journal.operations.get(operationId),
            tx.gateways.roots.get(params.targetGatewayId),
            tx.journal.operations.get(params.retirementOperationId),
            tx.gateways.assignments.get(params.targetGatewayId, params.uid),
        ]);
        const marker = migrationMarker(user);
        if (marker?.operationId !== operationId)
            return false;
        assertRestoreUnfenced(user);
        const operation = recordOrEmpty(stored);
        const input = recordOrEmpty(operation.input);
        if (typeof input.fromGatewayId !== "string" || input.fromGatewayId === "")
            throw new Error("retired activation preparation source is missing");
        const sourceGatewayId = input.fromGatewayId;
        const [sourceAssignment, sourceRoot] = await Promise.all([
            tx.gateways.assignments.get(sourceGatewayId, params.uid),
            tx.gateways.roots.get(sourceGatewayId),
        ]);
        const lease = user?.activationLease;
        const sourceEpoch = typeof lease?.sourceAssignmentEpoch === "number" ? lease.sourceAssignmentEpoch : NaN;
        const targetRoot = withoutRevision(storedTargetRoot);
        const retirement = recordOrEmpty(storedRetirement);
        const handoff = recordOrEmpty(operation.schedulerHandoff);
        const exact = [
            marker.state === "preparing", marker.phase === "preparing",
            operation.status === "failed", operation.userMigrationV2 === undefined,
            operation.schedulerHandoffReleased === true,
            preparationStepsMatch(operation, "failed"),
            input.uid === params.uid, input.toGatewayId === params.targetGatewayId,
            user?.gateway?.gatewayId === sourceGatewayId,
            handoff.uid === params.uid, handoff.fromGatewayId === sourceGatewayId, handoff.toGatewayId === params.targetGatewayId,
            preparationAssignmentMatches({ uid: params.uid, sourceGatewayId, sourceEpoch }, sourceAssignment),
            projectGatewayDesiredRootForGateway(withoutRevision(sourceRoot), sourceGatewayId)?.gatewayClass === "shared",
            targetAssignment === null,
            userActivationRecoveryTargetMatches({ operationId, input, openclaw: activationLeaseView(user), sourceEpoch, targetRoot }),
            projectGatewayDesiredRootForGateway(targetRoot, params.targetGatewayId)?.desiredStatus === "retired",
            recordOrEmpty(targetRoot?.retirementClaim).operationId === params.retirementOperationId,
            retirement.kind === "retire-gateway", retirement.status === "succeeded",
            recordOrEmpty(retirement.input).gatewayId === params.targetGatewayId,
        ].every(Boolean);
        if (!exact)
            throw new Error("retired activation preparation cleanup authority changed");
        await clearWorkspaceMigrationMarker(tx, user, params.uid);
        return true;
    });
}
function preparationStepsMatch(operation, unmountStatus) {
    if (operation.kind !== MIGRATE_USER_OPERATION_KIND ||
        !["running", "failed"].includes(String(operation.status)) ||
        operation.cutoverCommittedAt !== undefined || !Array.isArray(operation.steps))
        return false;
    const expected = {
        "keys-sync-state": "done",
        "pre-sync-state": "failed",
        "rollback:unmount-target": unmountStatus,
    };
    return operation.steps.length === Object.keys(expected).length &&
        operation.steps.every((value) => {
            const step = recordOrEmpty(value);
            return typeof step.name === "string" && Object.hasOwn(expected, step.name) && expected[step.name] === step.status;
        }) && new Set(operation.steps.map(value => recordOrEmpty(value).name)).size === Object.keys(expected).length;
}
class UserRestoreAuthorityUnavailableError extends Error {
}
function assertUserRestoreInput(input) {
    if (![input.uid, input.slug, input.gatewayId, input.fromGatewayId, input.operationId, input.attemptId].every(value => typeof value === "string" && value.length > 0) ||
        !Number.isSafeInteger(input.assignmentEpoch) || input.assignmentEpoch < 0 ||
        !Number.isSafeInteger(input.claimStartedAt) || input.claimStartedAt <= 0) {
        throw new UserRestoreAuthorityUnavailableError("user restore identity is invalid");
    }
}
async function readUserRestoreAuthority(tx, input) {
    assertUserRestoreInput(input);
    const [user, stored, assignment, gateway] = await Promise.all([
        tx.users.records.get(input.uid),
        tx.journal.operations.get(input.operationId),
        tx.gateways.assignments.get(input.gatewayId, input.uid),
        tx.gateways.roots.get(input.gatewayId),
    ]);
    if (gateway?.runtimeRestartFence !== undefined)
        throw new UserRestoreAuthorityUnavailableError("gateway runtime restart outcome is unresolved");
    const operation = recordOrEmpty(stored);
    const exact = [
        stored !== null,
        userRestoreOperationCurrent(operation, input),
        userRestoreAssignmentCurrent(assignment, input),
    ].every(Boolean);
    if (!exact || user === null || !userRestoreUserCurrent(user, input)) {
        throw new UserRestoreAuthorityUnavailableError("user restore authority changed");
    }
    return { user, operation, gateway };
}
function userRestoreUserCurrent(user, input) {
    return [
        user.slug === input.slug, interactiveAccess(user),
        user.gateway?.gatewayId === input.gatewayId, user.openclaw.status === "complete",
    ].every(Boolean);
}
function userRestoreOperationCurrent(operation, input) {
    const operationInput = recordOrEmpty(operation.input);
    const handoff = recordOrEmpty(operation.schedulerHandoff);
    return [
        operation.kind === "migrate-user", operation.status === "running",
        operation.startedAt === input.claimStartedAt,
        operation.cancellationRequestedAt === undefined || migrationCancellationDeferred(operation, input.operationId),
        operationInput.uid === input.uid, operationInput.toGatewayId === input.gatewayId,
        operationInput.fromGatewayId === input.fromGatewayId, input.fromGatewayId !== input.gatewayId,
        typeof operation.cutoverCommittedAt === "number" && Number.isFinite(operation.cutoverCommittedAt) && operation.cutoverCommittedAt > 0,
        handoff.uid === input.uid, handoff.slug === input.slug,
        handoff.fromGatewayId === input.fromGatewayId, handoff.toGatewayId === input.gatewayId,
    ].every(Boolean);
}
function userRestoreAssignmentCurrent(assignment, input) {
    if (assignment === null)
        return false;
    return [
        assignment.uid === input.uid, assignment.slug === input.slug,
        assignment.gatewayId === input.gatewayId, assignment.epoch === input.assignmentEpoch,
        assignment.state === "serving",
    ].every(Boolean);
}
function hasPriorUserRestoreWork(operation) {
    const histories = Array.isArray(operation.attemptHistory) ? operation.attemptHistory : [];
    const attempts = [operation, ...histories.map(recordOrEmpty)];
    return attempts.some(attempt => Array.isArray(attempt.steps) &&
        attempt.steps.some(step => recordOrEmpty(step).name === "restore-target"));
}
function restoreDispatchClaim(operation, intent) {
    if (intent.dispatchClaimStartedAt !== undefined) {
        return Number.isSafeInteger(intent.dispatchClaimStartedAt) && Number(intent.dispatchClaimStartedAt) > 0
            ? Number(intent.dispatchClaimStartedAt) : null;
    }
    if (Number(intent.dispatchedAt) >= Number(intent.claimStartedAt))
        return Number(intent.claimStartedAt);
    const history = Array.isArray(operation.attemptHistory) ? operation.attemptHistory.map(recordOrEmpty) : [];
    const candidates = history.filter(attempt => Number.isSafeInteger(attempt.startedAt) &&
        Number(attempt.startedAt) > 0 && Number(attempt.startedAt) <= Number(intent.dispatchedAt) &&
        Array.isArray(attempt.steps) && attempt.steps.some(step => recordOrEmpty(step).name === "restore-target"));
    return candidates.length === 1 ? Number(candidates[0].startedAt) : null;
}
function resumedRestoreIntent(current, input) {
    const prior = recordOrEmpty(current.operation.restoreAttempt);
    const fence = recordOrEmpty(current.user.fences.restoreFence);
    const identity = ["uid", "slug", "gatewayId", "fromGatewayId", "assignmentEpoch", "operationId"];
    const dispatchClaimStartedAt = restoreDispatchClaim(current.operation, prior);
    const validClock = [
        Number.isSafeInteger(prior.claimStartedAt), Number(prior.claimStartedAt) > 0,
        Number.isSafeInteger(prior.dispatchedAt), Number(prior.dispatchedAt) > 0,
        dispatchClaimStartedAt !== null, Number(dispatchClaimStartedAt) <= Number(prior.claimStartedAt),
        Number(prior.claimStartedAt) <= input.claimStartedAt, Number(prior.dispatchedAt) >= Number(dispatchClaimStartedAt),
    ].every(Boolean);
    const exact = prior.phase === "dispatched" && fence.phase === "dispatched" && validClock &&
        identity.every(key => prior[key] === input[key] && fence[key] === prior[key]) &&
        typeof prior.attemptId === "string" && prior.attemptId.trim().length > 0 &&
        ["attemptId", "claimStartedAt", "dispatchedAt", "dispatchClaimStartedAt"].every(key => fence[key] === prior[key]);
    if (!exact)
        throw new UserRestoreAuthorityUnavailableError("user restore resumption does not own the dispatch intent");
    if (current.user.fences.sourceTransferFence !== undefined)
        throw new UserRestoreAuthorityUnavailableError("user source transfer outcome is unresolved");
    return { ...input, attemptId: prior.attemptId, dispatchClaimStartedAt: dispatchClaimStartedAt };
}
export async function readUserRestoreAuthoritySnapshot(deps, scope) {
    return deps.store.transaction({ label: "fleet-state.readCustomerRestoreAuthoritySnapshot", readOnly: true }, async (tx) => {
        const user = await tx.users.records.get(scope.uid);
        const restoreFence = user?.fences.restoreFence;
        if (restoreFence === undefined)
            return undefined;
        const fence = recordOrEmpty(restoreFence);
        const operationId = fence.operationId;
        if (typeof operationId !== "string" || !operationId || operationId.includes("/")) {
            throw new UserRestoreAuthorityUnavailableError("user restore authority is malformed");
        }
        const operation = recordOrEmpty(await tx.journal.operations.get(operationId));
        const input = {
            ...scope, operationId,
            fromGatewayId: fence.fromGatewayId,
            assignmentEpoch: fence.assignmentEpoch,
            attemptId: fence.attemptId,
            claimStartedAt: operation.startedAt,
        };
        const current = await readUserRestoreAuthority(tx, input);
        if (current.gateway?.gatewayClass !== "shared")
            throw new UserRestoreAuthorityUnavailableError("user restore authority requires its assigned Shared gateway");
        const intent = recordOrEmpty(current.operation.restoreAttempt);
        if (fence.claimStartedAt !== input.claimStartedAt || intent.claimStartedAt !== input.claimStartedAt) {
            throw new UserRestoreAuthorityUnavailableError("user restore authority has not resumed under its current claim");
        }
        const resumed = resumedRestoreIntent(current, input);
        return {
            ...resumed, phase: "dispatched", migrationId: `mig-${operationId}`,
            dispatchedAt: intent.dispatchedAt,
        };
    }).catch((error) => {
        if (error instanceof UserRestoreAuthorityUnavailableError || error instanceof MalformedRecordError)
            return undefined;
        throw error;
    });
}
function userRestoreOperationFence(input) {
    return { status: ["running"], startedAt: input.claimStartedAt };
}
export async function beginUserRestore(deps, input, options = {}) {
    const now = nowMs(deps);
    return deps.store.transaction({ label: "fleet-state.beginCustomerRestore" }, async (tx) => {
        const current = await readUserRestoreAuthority(tx, input);
        if (options.resume === true) {
            const resumed = resumedRestoreIntent(current, input);
            const intent = { ...recordOrEmpty(current.operation.restoreAttempt), ...resumed };
            await tx.users.records.setFence(input.uid, "restoreFence", intent, current.user.fences.restoreFence ?? "absent");
            await tx.journal.operations.patch(input.operationId, { restoreAttempt: intent }, userRestoreOperationFence(input));
            return resumed;
        }
        assertRestoreUnfenced(current.user);
        if (current.operation.restoreAttempt !== undefined ||
            hasPriorUserRestoreWork(current.operation)) {
            throw new Error("user restore was already dispatched or has unknown prior work");
        }
        const intent = { ...input, dispatchClaimStartedAt: input.claimStartedAt, phase: "dispatched", dispatchedAt: now };
        await tx.users.records.setFence(input.uid, "restoreFence", intent, "absent");
        await tx.journal.operations.patch(input.operationId, { restoreAttempt: intent, lastProgressAt: now }, userRestoreOperationFence(input));
        return input;
    });
}
export async function acknowledgeUserRestore(deps, input) {
    const now = nowMs(deps);
    await deps.store.transaction({ label: "fleet-state.acknowledgeCustomerRestore" }, async (tx) => {
        const current = await readUserRestoreAuthority(tx, input);
        for (const value of [current.user.fences.restoreFence, current.operation.restoreAttempt]) {
            const intent = recordOrEmpty(value);
            if (intent.phase !== "dispatched" || Object.entries(input).some(([key, expected]) => intent[key] !== expected)) {
                throw new Error("user restore acknowledgement does not own the dispatch intent");
            }
        }
        await tx.users.records.setFence(input.uid, "restoreFence", CLEAR, current.user.fences.restoreFence ?? "absent");
        await tx.journal.operations.patch(input.operationId, {
            restoreAttempt: { ...recordOrEmpty(current.operation.restoreAttempt), phase: "acknowledged", acknowledgedAt: now },
            lastProgressAt: now,
        }, userRestoreOperationFence(input));
    });
}
export function legacyForwardRecoveryMatches(operationId, input, handoff) {
    const recovery = recordOrEmpty(handoff.forwardRecovery);
    return recovery.schemaVersion === 1 && recovery.phase === "source-flushed" &&
        readSchedulerMigrationIdentity(operationId, handoff.migrationId) !== null &&
        handoff.uid === input.uid && handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId &&
        Number.isSafeInteger(recovery.sourceEpoch) && Number(recovery.sourceEpoch) >= 0;
}
export function migrationCancellationDeferred(operation, operationId) {
    const input = recordOrEmpty(operation.input);
    const state = recordOrEmpty(operation.userMigrationV2);
    const durableV2 = state.operationId === operationId && state.uid === input.uid &&
        state.sourceGatewayId === input.fromGatewayId && state.targetGatewayId === input.toGatewayId &&
        ["sourceQuiesced", "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete"].includes(String(state.phase));
    return legacyForwardRecoveryMatches(operationId, input, recordOrEmpty(operation.schedulerHandoff)) || durableV2;
}
function userMigrationV2FenceIsExact(operation, fence) {
    const state = recordOrEmpty(operation?.userMigrationV2);
    const sourceRootFence = state.sourceRootFence;
    const targetRootFence = state.targetRootFence;
    const claimBound = recordOrEmpty(operation?.input).sourceTransferMode === "retained-pod" || fence.claimStartedAt !== undefined;
    const claimCurrent = !claimBound || (Number.isSafeInteger(fence.claimStartedAt) && (fence.claimStartedAt ?? 0) > 0 &&
        operation?.startedAt === fence.claimStartedAt);
    return [
        operation?.status === "running",
        claimCurrent,
        state.phase === "targetVerified",
        state.operationId === fence.operationId,
        state.migrationId === fence.migrationId,
        state.uid === fence.uid,
        state.slug === fence.slug,
        state.sourceGatewayId === fence.sourceGatewayId,
        state.sourceEpoch === fence.sourceEpoch,
        state.sourceRelease === fence.sourceRelease,
        state.sourceAssignmentMode === fence.sourceAssignmentMode,
        userMigrationV2GatewayRootFenceEqual(sourceRootFence, fence.sourceRootFence),
        state.targetGatewayId === fence.targetGatewayId,
        state.targetRelease === fence.targetRelease,
        userMigrationV2GatewayRootFenceEqual(targetRootFence, fence.targetRootFence),
    ].every(Boolean);
}
export async function commitCutoverAtomic(deps, params) {
    const now = nowMs(deps);
    if (!params.userMigrationV2Fence)
        return commitCutoverInStore(deps, params, now, null);
    return withCurrentSizingKey({ store: deps.store, readSizingKey: deps.readSizingKey, uid: params.uid, now }, (current) => commitCutoverInStore(deps, params, now, current));
}
async function commitCutoverInStore(deps, params, now, current) {
    await deps.store.transaction({ label: "fleet-state.commitCutoverAtomic" }, async (tx) => {
        const user = await tx.users.records.get(params.uid);
        current?.assertCurrent(user);
        assertRestoreUnfenced(user);
        const prior = await readPriorAssignment(tx, params);
        const targetRoot = await tx.gateways.roots.get(params.toGatewayId);
        assertTargetAcceptsCutover(targetRoot, params.toGatewayId);
        if (params.userMigrationV2Fence) {
            const alreadyCommitted = await assertUserMigrationV2FenceCurrent({
                tx, params, user, targetRoot, prior, sizingKey: current?.sizingKey ?? null,
            });
            if (alreadyCommitted)
                return;
        }
        const activationSourceMove = await userActivationSourceCutoverMove({ tx, params, user, prior, targetRoot });
        await updateUserMirror(tx, params, user, targetRoot, activationSourceMove);
        await updateAssignment(tx, params, prior, now);
    });
}
function activationSourceAssignmentCurrent(assignment, params, leaseEpoch) {
    if (assignment === null)
        return false;
    return [
        leaseEpoch === assignment.epoch,
        assignment.uid === params.uid, assignment.gatewayId === params.fromGatewayId,
        Number.isSafeInteger(assignment.epoch), assignment.epoch >= 0,
        assignment.epoch < Number.MAX_SAFE_INTEGER,
        assignment.state === "serving" || assignment.state === "quiescing",
    ].every(Boolean);
}
async function userActivationSourceCutoverMove(input) {
    const { params, prior, user } = input;
    const lease = user?.activationLease ?? null;
    const applies = [
        params.flipMirror, params.assignment !== null, params.fromGatewayId !== params.toGatewayId,
        input.targetRoot?.gatewayClass === "shared",
        ["requested", "provisioning", "activating"].includes(String(lease?.status)),
    ].every(Boolean);
    if (!applies || lease === null)
        return null;
    const source = await input.tx.gateways.roots.get(params.fromGatewayId);
    const exact = [
        lease.status !== "activating",
        source?.gatewayClass === "shared",
        user?.gateway?.gatewayId === params.fromGatewayId,
        lease.sourceGatewayId === params.fromGatewayId,
        activationSourceAssignmentCurrent(prior.assignment, params, lease.sourceAssignmentEpoch),
    ].every(Boolean);
    if (!exact)
        throw new Error("User activation source changed before Shared cutover");
    return {
        fence: { leaseId: lease.leaseId, generation: lease.generation },
        sourceAssignmentEpoch: prior.epoch + 1,
    };
}
async function readPriorAssignment(tx, params) {
    if (!params.assignment) {
        return { assignment: null, epoch: 0 };
    }
    const assignment = await tx.gateways.assignments.get(params.fromGatewayId, params.uid);
    return { assignment, epoch: assignment?.epoch ?? 0 };
}
function assertTargetAcceptsCutover(targetRoot, gatewayId) {
    if (targetRoot?.desiredStatus === "retired" || targetRoot?.retirementClaim != null) {
        throw new Error(`gateway ${gatewayId} has a current retirement claim`);
    }
}
async function assertUserMigrationV2FenceCurrent(input) {
    const { tx, params, user, targetRoot, prior, sizingKey } = input;
    const fence = params.userMigrationV2Fence;
    assertUserMigrationV2ParametersExact(params, fence);
    const [stored, targetAssignment, sourceRoot] = await Promise.all([
        tx.journal.operations.get(fence.operationId),
        tx.gateways.assignments.get(params.toGatewayId, params.uid),
        tx.gateways.roots.get(fence.sourceGatewayId),
    ]);
    const operation = operationData(stored);
    assertUserMigrationV2ProofsExact({
        fence,
        operation,
        targetRoot: withoutRevision(targetRoot),
        sourceRoot: withoutRevision(sourceRoot),
    });
    if (userMigrationAlreadyCommitted(prior, targetAssignment, fence))
        return true;
    assertUserActivationCutoverAuthorized({ operation, user, targetRoot, fence, sizingKey });
    assertUserMigrationSourceAssignmentExact(prior, fence);
    return false;
}
function assertUserActivationCutoverAuthorized(input) {
    const operationInput = recordOrEmpty(input.operation?.input);
    const allocation = recordOrEmpty(input.targetRoot?.allocation);
    if (operationInput.source !== "builder-activation-lease" ||
        allocation.kind !== "disposable-builder")
        return;
    const lease = recordOrEmpty(input.user?.activationLease);
    const authorized = [
        interactiveAccess(input.user),
        input.sizingKey !== null,
        lease.status === "activating",
        lease.targetGatewayId === input.fence.targetGatewayId,
        typeof lease.leaseId === "string" && lease.leaseId.length > 0,
        Number.isSafeInteger(lease.generation) && lease.generation > 0,
        allocation.kind === "disposable-builder",
        allocation.claimedByUid === input.fence.uid,
        allocation.leaseId === lease.leaseId,
        allocation.generation === lease.generation,
    ].every(Boolean);
    if (!authorized) {
        throw new Error("User activation authorization changed before cutover");
    }
}
function assertUserMigrationV2ParametersExact(params, fence) {
    const parametersExact = [
        fence.uid === params.uid,
        fence.slug === params.slug,
        fence.sourceGatewayId === params.fromGatewayId,
        fence.targetGatewayId === params.toGatewayId,
        params.assignment !== null,
    ].every(Boolean);
    if (!parametersExact) {
        throw new Error("user migration V2 cutover parameters changed after verification");
    }
}
function assertUserMigrationV2ProofsExact(input) {
    const { fence, operation, targetRoot, sourceRoot } = input;
    if (!userMigrationV2FenceIsExact(operation, fence)) {
        throw new Error("user migration V2 is not durably cutover-ready");
    }
    if (!userMigrationV2GatewayRootFenceMatches(targetRoot, fence.targetRootFence)) {
        throw new Error("user migration V2 target root changed before cutover");
    }
    if (!userMigrationV2GatewayRootFenceMatches(sourceRoot, fence.sourceRootFence)) {
        throw new Error("user migration V2 source root changed before cutover");
    }
}
function userMigrationAlreadyCommitted(prior, targetAssignment, fence) {
    return prior.assignment === null &&
        targetAssignment?.gatewayId === fence.targetGatewayId &&
        targetAssignment.updatedByOperationId === fence.operationId &&
        targetAssignment.state === "serving";
}
function assertUserMigrationSourceAssignmentExact(prior, fence) {
    const sourceAssignmentExact = [
        prior.epoch === fence.sourceEpoch,
        prior.assignment?.uid === fence.uid,
        prior.assignment?.slug === fence.slug,
        prior.assignment?.gatewayId === fence.sourceGatewayId,
        prior.assignment?.state === "quiescing",
        prior.assignment?.updatedByOperationId === fence.operationId,
    ].every(Boolean);
    if (!sourceAssignmentExact) {
        throw new Error("user migration V2 source assignment changed before cutover");
    }
}
async function updateUserMirror(tx, params, user, targetRoot, activationSourceMove) {
    if (!params.flipMirror) {
        await clearWorkspaceMigrationMarker(tx, user, params.uid);
        return;
    }
    const controlState = resolveUserGatewayControlState(withoutRevision(targetRoot), params.uid);
    if (activationSourceMove !== null) {
        await tx.users.records.patchActivationLease(params.uid, {
            sourceGatewayId: params.toGatewayId,
            sourceAssignmentEpoch: activationSourceMove.sourceAssignmentEpoch,
        }, activationSourceMove.fence);
    }
    await tx.users.records.setGatewayMirror(params.uid, {
        gatewayId: params.toGatewayId,
        gatewayAssignedAt: { serverNow: true },
        gatewayProfile: controlState.gatewayProfile,
        controlUiEnabled: controlState.controlUiEnabled,
    }, activationSourceMove === null ? { gatewayId: user?.gateway?.gatewayId ?? null } : undefined);
    await tx.users.records.setFence(params.uid, "migration", CLEAR);
}
async function updateAssignment(tx, params, prior, now) {
    if (!params.assignment)
        return;
    await tx.gateways.assignments.put({
        uid: params.uid,
        slug: params.slug,
        gatewayId: params.toGatewayId,
        source: params.assignment.source,
        state: "serving",
        epoch: prior.epoch + 1,
        createdAt: now,
        updatedAt: now,
        updatedByOperationId: params.assignment.updatedByOperationId,
    });
    if (params.fromGatewayId !== params.toGatewayId) {
        await tx.gateways.assignments.delete(params.fromGatewayId, params.uid, prior.assignment === null ? undefined : { epoch: prior.assignment.epoch });
    }
}
function millisFromUnknown(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (value &&
        typeof value === "object" &&
        typeof value.toMillis === "function") {
        const result = value.toMillis();
        return typeof result === "number" && Number.isFinite(result) ? result : null;
    }
    return null;
}
function recoveryOperationMatches(operation, params) {
    const input = recordOrEmpty(operation?.input);
    const operationMatches = [
        operation?.kind === MIGRATE_USER_OPERATION_KIND,
        operation?.status === "succeeded",
        operation?.origin === "automatic",
        operation?.createdBy === "glm-controller-placement-policy",
        operation?.gatewayId === params.toGatewayId,
        operation?.inputUid === params.uid,
        input.uid === params.uid,
        input.slug === params.slug,
        input.recoveryKind === params.kind,
        input.fromGatewayId === params.fromGatewayId,
        input.toGatewayId === params.toGatewayId,
        input.sourceEpoch === params.expectedSourceEpoch,
    ].every(Boolean);
    return operationMatches;
}
function recoveredTargetAssignmentExact(assignment, params, operationAt) {
    if (assignment === null)
        return false;
    return [
        assignment.uid === params.uid,
        assignment.slug === params.slug,
        assignment.gatewayId === params.toGatewayId,
        assignment.source === "repair",
        assignment.state === "serving",
        assignment.epoch === params.expectedSourceEpoch + 1,
        assignment.updatedByOperationId === params.operationId,
        assignment.updatedAt === operationAt,
    ].every(Boolean);
}
function recoveryAlreadyCommitted(input) {
    const mirror = input.user?.gateway;
    const targetRoot = projectGatewayDesiredRootForGateway(input.targetRootData, input.params.toGatewayId);
    const controlState = resolveUserGatewayControlState(targetRoot
        ? { ...targetRoot, builderAccess: targetRoot.builderAccess ?? undefined }
        : undefined, input.params.uid);
    const operationAt = millisFromUnknown(input.operation?.completedAt);
    const targetAssignmentExact = recoveredTargetAssignmentExact(input.targetAssignment, input.params, operationAt);
    const operationTimingExact = [
        operationAt !== null,
        input.operation?.createdAt === operationAt,
        input.operation?.startedAt === operationAt,
    ].every(Boolean);
    return [
        recoveryOperationMatches(input.operation, input.params),
        !input.sourceAssignmentExists,
        mirror?.gatewayId === input.params.toGatewayId,
        millisFromUnknown(mirror?.gatewayAssignedAt) === operationAt,
        mirror?.gatewayProfile === controlState.gatewayProfile,
        mirror?.controlUiEnabled === controlState.controlUiEnabled,
        targetAssignmentExact,
        operationTimingExact,
        input.user?.fences.runtimeReset === undefined,
    ].every(Boolean);
}
function recoveryTargetRootReady(root, params) {
    if (root === null)
        return false;
    return [
        params.sharedGatewayIds.includes(params.toGatewayId),
        root.gatewayClass === "shared",
        root.desiredStatus === "running",
        root.liveRelease !== null,
        root.desiredRelease === root.liveRelease,
    ].every(Boolean);
}
function recoveryTargetRuntimeReady(runtime, root, params, now) {
    if (runtime === null)
        return false;
    const heartbeatAt = millisFromUnknown(runtime.heartbeat.lastHeartbeatAt);
    const heartbeatFresh = heartbeatAt === null
        ? false
        : now - heartbeatAt <= params.targetHeartbeatMaxAgeMs;
    return [
        runtime.gatewayId === params.toGatewayId,
        runtime.release === root.liveRelease,
        runtime.lifecycle === "serving",
        runtime.heartbeat.status === "ready",
        heartbeatFresh,
        hasFreshReadyKubernetesObservation(runtime, now, params.targetHeartbeatMaxAgeMs),
    ].every(Boolean);
}
function assertRecoveryTargetReady(input) {
    const { params, targetRootData, targetRuntimeData, now } = input;
    const root = projectGatewayDesiredRootForGateway(targetRootData, params.toGatewayId);
    const runtime = isGatewayRuntimeDoc(targetRuntimeData) ? targetRuntimeData : null;
    if (!recoveryTargetRootReady(root, params) ||
        !recoveryTargetRuntimeReady(runtime, root, params, now)) {
        throw new Error(`recovery target runtime is not freshly ready: ${params.toGatewayId}`);
    }
}
function assertRecoverySourceIdentity(root, user, sourceAssignment, params) {
    if (!root || !sourceAssignment) {
        throw new Error("unavailable gateway recovery source changed before cutover");
    }
    const exact = [
        user?.gateway?.gatewayId === params.fromGatewayId,
        sourceAssignment.uid === params.uid,
        sourceAssignment.slug === params.slug,
        sourceAssignment.gatewayId === params.fromGatewayId,
        sourceAssignment.state === "serving",
        sourceAssignment.epoch === params.expectedSourceEpoch,
    ].every(Boolean);
    if (!exact)
        throw new Error("unavailable gateway recovery source changed before cutover");
}
function assertSharedRecoverySource(root, params) {
    const invalid = [
        root.gatewayClass !== "shared",
        !["running", "draining"].includes(root.desiredStatus),
        !params.sharedGatewayIds.includes(params.fromGatewayId),
    ].some(Boolean);
    if (invalid)
        throw new Error("shared gateway recovery source is not an active pool member");
}
function assertMissingDrainingSource(input) {
    const { sourceRootData: root, sourceRuntime, sourceAssignment, now, maxAgeMs } = input;
    const runtime = runtimeDocument(sourceRuntime);
    if (!root || !isGatewayRuntimeDoc(runtime) || runtime.kubernetes === undefined) {
        throw new Error("draining Shared source is not confirmed missing");
    }
    const observed = runtime.kubernetes;
    const heartbeat = millisFromUnknown(runtime.heartbeat.lastHeartbeatAt);
    const safe = [
        root.retirementClaim == null, root.runtimeRestartFence == null,
        root.liveRelease === root.desiredRelease, runtime.release === root.liveRelease,
        sourceAssignment?.sharedSurgeForwardRecovery === undefined,
        observed.status === "missing", observed.totalPods === 0, observed.readyPods === 0,
        now >= observed.observedAt && now - observed.observedAt <= maxAgeMs,
        heartbeat !== null && now - heartbeat > maxAgeMs,
    ].every(Boolean);
    if (!safe)
        throw new Error("draining Shared source is not confirmed missing");
}
function assertRecoverySource(input) {
    const { params, sourceRootData, user, sourceAssignment } = input;
    const root = projectGatewayDesiredRootForGateway(sourceRootData, params.fromGatewayId);
    assertRecoverySourceIdentity(root, user, sourceAssignment, params);
    assertSharedRecoverySource(root, params);
    if (root.desiredStatus === "draining")
        assertMissingDrainingSource({ ...input, maxAgeMs: params.targetHeartbeatMaxAgeMs });
}
function attemptsStoppedBeforeSharedTransfer(operation, params) {
    const history = operation.attemptHistory ?? [];
    const missingSource = `expected exactly one ready pod for transport=${params.fromGatewayId}; found 0`;
    const compatibilityFailure = `gateway compatibility pending: status 503: expected exactly one running pod for transport=${params.fromGatewayId}; found 0`;
    const destinationAbortFailure = `/scheduler/${params.toGatewayId} transport failed: fetch failed`;
    const exactDestinationCleanup = operation.input.toGatewayId === params.toGatewayId &&
        operation.input.recoverSourceOnly !== true && operation.input.sourceTransferMode === undefined;
    const missedKeysTransfer = (attempt) => attempt.steps.length === 1 &&
        attempt.steps[0].name === "keys-sync-state" && attempt.steps[0].status === "failed" &&
        attempt.error === missingSource;
    const stoppedBeforeSteps = (attempt) => attempt.steps.length === 0 &&
        (attempt.error === compatibilityFailure || (exactDestinationCleanup && attempt.error === destinationAbortFailure));
    const [first, ...retries] = history;
    return first !== undefined && missedKeysTransfer(first) &&
        retries.every(attempt => missedKeysTransfer(attempt) || stoppedBeforeSteps(attempt));
}
async function assertDrainingMigrationUnclaimed(tx, operation, params) {
    const handoff = recordOrEmpty(operation.schedulerHandoff);
    const safe = [
        operation.status === "pending", operation.startedAt == null, operation.completedAt == null,
        operation.input.uid === params.uid, operation.input.fromGatewayId === params.fromGatewayId,
        operation.steps.length === 0, operation.sourceTransferExecution === undefined,
        operation.cutoverCommittedAt === undefined, operation.userMigrationV2 === undefined,
        operation.restoreAttempt === undefined, operation.schedulerHandoffLost === undefined,
        handoff.stageAfterCutover === undefined, handoff.stagedAt === undefined, handoff.forwardRecovery === undefined,
        handoff.sourceRecovery === undefined,
    ].every(Boolean);
    if (!safe)
        throw new Error("missing draining Shared source has unresolved migration custody");
    if (operation.schedulerHandoff === undefined || operation.schedulerHandoffReleased === true)
        return;
    const exactHandoff = handoff.uid === params.uid && handoff.slug === params.slug &&
        handoff.fromGatewayId === params.fromGatewayId && handoff.toGatewayId === operation.input.toGatewayId &&
        readSchedulerMigrationIdentity(operation.id, handoff.migrationId) !== null;
    if (handoff.scheduleTransfer !== true || typeof handoff.migrationId !== "string" || !exactHandoff ||
        !attemptsStoppedBeforeSharedTransfer(operation, params) ||
        await tx.users.scheduleTransfers.get(params.uid, handoff.migrationId) !== null) {
        throw new Error("missing draining Shared source has unresolved scheduler custody");
    }
}
async function supersedeDrainingMigrations(tx, params, now) {
    const active = await tx.journal.operations.listForUid(params.uid, {
        kind: MIGRATE_USER_OPERATION_KIND, statuses: ["pending", "running"],
    });
    for (const operation of active)
        await assertDrainingMigrationUnclaimed(tx, operation, params);
    for (const operation of active) {
        await tx.journal.operations.patch(operation.id, {
            status: "failed", completedAt: now, rolledBack: false, nextAttemptAt: CLEAR, waitingOn: CLEAR,
            supersededBy: { kind: "missing-shared-source-recovery", operationId: params.operationId },
            error: "superseded by confirmed missing Shared source recovery",
        }, { status: ["pending"] });
    }
}
async function clearRecoveredSourceMount(tx, sourceRuntime, gatewayId, slug) {
    const runtime = runtimeDocument(sourceRuntime);
    if (!isGatewayRuntimeDoc(runtime) || !runtime.heartbeat.mountedCustomers.includes(slug))
        return;
    await tx.fleetRegistry.patch(gatewayId, {
        heartbeat: {
            ...runtime.heartbeat,
            mountedCustomers: runtime.heartbeat.mountedCustomers.filter((mountedUser) => mountedUser !== slug),
        },
    });
}
export async function commitUnavailableGatewayRecoveryAtomic(deps, params) {
    if (params.kind !== "recover-shared-customer") {
        throw new Error("User recovery requires its retained home; metadata-only recovery is forbidden");
    }
    if (!params.operationId ||
        !Number.isSafeInteger(params.expectedSourceEpoch) ||
        params.expectedSourceEpoch < 0 ||
        params.fromGatewayId === params.toGatewayId) {
        throw new Error("unavailable gateway recovery parameters are invalid");
    }
    const now = nowMs(deps);
    await deps.store.transaction({ label: "fleet-state.commitUnavailableGatewayRecoveryAtomic" }, async (tx) => {
        const [operation, user, sourceRoot, targetRoot, sourceRuntime, targetRuntime, sourceAssignment, targetAssignment,] = await Promise.all([
            tx.journal.operations.get(params.operationId),
            tx.users.records.get(params.uid),
            tx.gateways.roots.get(params.fromGatewayId),
            tx.gateways.roots.get(params.toGatewayId),
            tx.fleetRegistry.get(params.fromGatewayId),
            tx.fleetRegistry.get(params.toGatewayId),
            tx.gateways.assignments.get(params.fromGatewayId, params.uid),
            tx.gateways.assignments.get(params.toGatewayId, params.uid),
        ]);
        assertRestoreUnfenced(user);
        const targetRootData = withoutRevision(targetRoot);
        if (recoveryAlreadyCommitted({
            params,
            operation: operationData(operation),
            user,
            targetRootData,
            sourceAssignmentExists: sourceAssignment !== null,
            targetAssignment,
        })) {
            return;
        }
        if (operation !== null) {
            throw new Error(`recovery operation ${params.operationId} conflicts with current authority`);
        }
        const targetRuntimeData = runtimeDocument(targetRuntime);
        assertRecoveryTargetReady({ params, targetRootData, targetRuntimeData, now });
        if (!params.validateTarget) {
            throw new Error("unavailable gateway recovery requires an atomic target admission fence");
        }
        await params.validateTarget({
            transaction: tx,
            targetGatewayId: params.toGatewayId,
            targetRoot: targetRootData,
            targetRuntime: targetRuntimeData,
        });
        assertRecoverySource({
            params,
            sourceRootData: withoutRevision(sourceRoot),
            sourceRuntime,
            user,
            sourceAssignment,
            now,
        });
        if (sourceRoot?.desiredStatus === "draining")
            await supersedeDrainingMigrations(tx, params, now);
        const controlState = resolveUserGatewayControlState(targetRootData, params.uid);
        await clearRecoveredSourceMount(tx, sourceRuntime, params.fromGatewayId, params.slug);
        await tx.users.records.setGatewayMirror(params.uid, {
            gatewayId: params.toGatewayId,
            gatewayAssignedAt: now,
            gatewayProfile: controlState.gatewayProfile,
            controlUiEnabled: controlState.controlUiEnabled,
        }, { gatewayId: params.fromGatewayId });
        await tx.users.records.setFence(params.uid, "migration", CLEAR);
        await tx.gateways.assignments.put({
            uid: params.uid,
            slug: params.slug,
            gatewayId: params.toGatewayId,
            source: "repair",
            state: "serving",
            epoch: params.expectedSourceEpoch + 1,
            createdAt: now,
            updatedAt: now,
            updatedByOperationId: params.operationId,
        });
        await tx.gateways.assignments.delete(params.fromGatewayId, params.uid, { epoch: params.expectedSourceEpoch });
        await tx.journal.operations.put({
            id: params.operationId,
            kind: MIGRATE_USER_OPERATION_KIND,
            status: "succeeded",
            origin: "automatic",
            createdBy: "glm-controller-placement-policy",
            createdAt: now,
            startedAt: now,
            completedAt: now,
            input: {
                uid: params.uid,
                slug: params.slug,
                recoveryKind: params.kind,
                fromGatewayId: params.fromGatewayId,
                toGatewayId: params.toGatewayId,
                sourceEpoch: params.expectedSourceEpoch,
            },
            steps: [],
            gatewayId: params.toGatewayId,
            inputUid: params.uid,
        });
    });
    return { operationId: params.operationId };
}
function priorDisposableRecovery(input) {
    const { operation, params } = input;
    const priorInput = recordOrEmpty(operation?.input);
    const lease = recordOrEmpty(priorInput.disposableLease);
    const sourceGatewayId = typeof priorInput.fromGatewayId === "string"
        ? priorInput.fromGatewayId
        : "";
    const leaseId = typeof lease.leaseId === "string" ? lease.leaseId : "";
    const leaseGeneration = lease.generation;
    const exact = [
        operation?.kind === MIGRATE_USER_OPERATION_KIND,
        operation?.status === "succeeded",
        operation?.origin === "automatic",
        operation?.createdBy === "glm-controller-placement-policy",
        operation?.gatewayId === params.targetGatewayId,
        operation?.inputUid === params.uid,
        priorInput.uid === params.uid,
        priorInput.slug === params.slug,
        priorInput.recoveryKind === "recover-disposable-customer",
        priorInput.toGatewayId === params.targetGatewayId,
        priorInput.sourceEpoch === params.expectedAssignmentEpoch - 1,
        sourceGatewayId.length > 0,
        leaseId.length > 0,
        Number.isSafeInteger(leaseGeneration),
        leaseGeneration >= 0,
    ].every(Boolean);
    return exact
        ? { sourceGatewayId, leaseId, leaseGeneration: leaseGeneration }
        : null;
}
function recoveredRuntimeResetMarker(input) {
    return {
        status: "pending",
        uid: input.params.uid,
        slug: input.params.slug,
        operationId: input.params.operationId,
        sourceGatewayId: input.prior.sourceGatewayId,
        targetGatewayId: input.params.targetGatewayId,
        generation: input.params.expectedAssignmentEpoch + 1,
        disposableLeaseId: input.prior.leaseId,
        disposableLeaseGeneration: input.prior.leaseGeneration,
        requestedAt: input.requestedAt,
    };
}
function storedResetMatches(value, expected) {
    const actual = recordOrEmpty(value);
    if (actual.status !== "pending" && actual.status !== "acknowledged")
        return false;
    return Object.entries(expected)
        .filter(([key]) => key !== "status")
        .every(([key, expectedValue]) => actual[key] === expectedValue);
}
function recoveredRuntimeResetReplayIsExact(input) {
    const operationInput = recordOrEmpty(input.operation.input);
    return [
        input.operation.kind === MIGRATE_USER_OPERATION_KIND,
        input.operation.status === "succeeded",
        operationInput.recoveryKind === "recover-disposable-customer-runtime-reset",
        operationInput.previousRecoveryOperationId === input.params.previousRecoveryOperationId,
        input.assignment?.epoch === input.params.expectedAssignmentEpoch + 1,
        input.assignment?.updatedByOperationId === input.params.operationId,
        storedResetMatches(input.runtimeReset, input.marker),
    ].every(Boolean);
}
function recoveredRuntimeResetTargetIsReady(input) {
    const heartbeatAt = millisFromUnknown(input.targetRuntime?.heartbeat.lastHeartbeatAt);
    return [
        input.targetRoot?.gatewayClass === "shared",
        input.targetRoot?.desiredStatus === "running",
        input.targetRoot?.liveRelease !== null,
        input.targetRoot?.desiredRelease === input.targetRoot?.liveRelease,
        input.targetRuntime?.gatewayId === input.params.targetGatewayId,
        input.targetRuntime?.release === input.targetRoot?.liveRelease,
        input.targetRuntime?.lifecycle === "serving",
        heartbeatAt !== null,
        heartbeatAt !== null && input.now - heartbeatAt <= input.params.targetHeartbeatMaxAgeMs,
        !input.targetRuntime?.heartbeat.mountedCustomers.includes(input.params.slug),
    ].every(Boolean);
}
function recoveredRuntimeResetUserStateIsExact(input) {
    return [
        input.user?.gateway?.gatewayId === input.params.targetGatewayId,
        input.user?.fences.runtimeReset === undefined,
        input.assignment?.uid === input.params.uid,
        input.assignment?.slug === input.params.slug,
        input.assignment?.gatewayId === input.params.targetGatewayId,
        input.assignment?.source === "repair",
        input.assignment?.state === "serving",
        input.assignment?.epoch === input.params.expectedAssignmentEpoch,
        input.assignment?.updatedByOperationId === input.params.previousRecoveryOperationId,
    ].every(Boolean);
}
export async function commitRecoveredDisposableRuntimeResetAtomic(deps, params) {
    if (!params.operationId ||
        !params.previousRecoveryOperationId ||
        !params.sharedGatewayIds.includes(params.targetGatewayId) ||
        !Number.isSafeInteger(params.expectedAssignmentEpoch) ||
        params.expectedAssignmentEpoch < 1) {
        throw new Error("recovered disposable runtime reset parameters are invalid");
    }
    const now = nowMs(deps);
    await deps.store.transaction({ label: "fleet-state.commitRecoveredDisposableRuntimeResetAtomic" }, async (tx) => {
        const [user, storedTargetRoot, storedTargetRuntime, assignment, previousOperation, operation,] = await Promise.all([
            tx.users.records.get(params.uid),
            tx.gateways.roots.get(params.targetGatewayId),
            tx.fleetRegistry.get(params.targetGatewayId),
            tx.gateways.assignments.get(params.targetGatewayId, params.uid),
            tx.journal.operations.get(params.previousRecoveryOperationId),
            tx.journal.operations.get(params.operationId),
        ]);
        assertRestoreUnfenced(user);
        const targetRoot = projectGatewayDesiredRootForGateway(withoutRevision(storedTargetRoot), params.targetGatewayId);
        const targetRuntimeData = runtimeDocument(storedTargetRuntime);
        const targetRuntime = isGatewayRuntimeDoc(targetRuntimeData) ? targetRuntimeData : null;
        const prior = priorDisposableRecovery({
            operation: operationData(previousOperation),
            params,
        });
        if (!prior)
            throw new Error("previous disposable recovery fence changed");
        const marker = recoveredRuntimeResetMarker({ params, prior, requestedAt: now });
        if (operation !== null) {
            if (recoveredRuntimeResetReplayIsExact({
                params,
                operation: recordOrEmpty(operation),
                assignment,
                runtimeReset: user?.fences.runtimeReset,
                marker,
            }))
                return;
            throw new Error(`recovered runtime reset ${params.operationId} conflicts with current state`);
        }
        const targetExact = recoveredRuntimeResetTargetIsReady({
            params,
            targetRoot,
            targetRuntime,
            now,
        }) && recoveredRuntimeResetUserStateIsExact({
            params,
            user,
            assignment,
        });
        if (!targetExact || assignment === null)
            throw new Error("recovered disposable runtime reset fence changed");
        await tx.users.records.setFence(params.uid, "runtimeReset", marker, "absent");
        const { revision: _revision, ...current } = assignment;
        await tx.gateways.assignments.put({
            ...current,
            epoch: params.expectedAssignmentEpoch + 1,
            updatedAt: now,
            updatedByOperationId: params.operationId,
        });
        await tx.journal.operations.put({
            id: params.operationId,
            kind: MIGRATE_USER_OPERATION_KIND,
            status: "succeeded",
            origin: "automatic",
            createdBy: "glm-controller-placement-policy",
            createdAt: now,
            startedAt: now,
            completedAt: now,
            input: {
                uid: params.uid,
                slug: params.slug,
                recoveryKind: "recover-disposable-customer-runtime-reset",
                previousRecoveryOperationId: params.previousRecoveryOperationId,
                targetGatewayId: params.targetGatewayId,
                sourceEpoch: params.expectedAssignmentEpoch,
                disposableLease: {
                    leaseId: prior.leaseId,
                    generation: prior.leaseGeneration,
                },
            },
            steps: [],
            gatewayId: params.targetGatewayId,
            inputUid: params.uid,
        });
    });
    return { operationId: params.operationId };
}
export async function markSharedSurgeForwardRecovery(deps, params) {
    await writeSharedSurgeForwardRecovery(deps, { ...params, receivingPodUid: params.targetPodUid });
}
export async function rebindSharedSurgeForwardRecovery(deps, params) {
    await writeSharedSurgeForwardRecovery(deps, params);
}
async function writeSharedSurgeForwardRecovery(deps, params) {
    if (![params.gatewayId, params.uid, params.slug, params.operationId, params.targetPodUid, params.receivingPodUid,
        params.expectedReceivingPodUid ?? params.targetPodUid].every(value => typeof value === "string" && value.length > 0 && !value.includes("/")) ||
        !Number.isSafeInteger(params.epoch) || params.epoch < 0 ||
        !Number.isSafeInteger(params.expectedUpdatedAt) || params.expectedUpdatedAt <= 0) {
        throw new Error("Shared surge forward recovery identity is invalid");
    }
    await deps.store.transaction({ label: "fleet-state.writeSharedSurgeForwardRecovery" }, async (tx) => {
        const [assignment, root] = await Promise.all([
            tx.gateways.assignments.get(params.gatewayId, params.uid),
            tx.gateways.roots.get(params.gatewayId),
        ]);
        const marker = { operationId: params.operationId, targetPodUid: params.targetPodUid, receivingPodUid: params.receivingPodUid };
        const prior = params.expectedReceivingPodUid === undefined ? marker : { ...marker, receivingPodUid: params.expectedReceivingPodUid };
        const markerMatches = isDeepStrictEqual(assignment?.sharedSurgeForwardRecovery, prior) ||
            params.expectedReceivingPodUid === undefined && assignment?.sharedSurgeForwardRecovery === undefined;
        const exact = [assignment !== null, root?.gatewayClass === "shared",
            assignment?.uid === params.uid, assignment?.slug === params.slug, assignment?.gatewayId === params.gatewayId,
            assignment?.epoch === params.epoch, assignment?.state === "quiescing",
            assignment?.updatedByOperationId === params.operationId, assignment?.updatedAt === params.expectedUpdatedAt,
            markerMatches,
        ].every(Boolean);
        if (!exact)
            throw new Error("Shared surge forward recovery authority changed");
        await tx.gateways.assignments.patch(params.gatewayId, params.uid, { sharedSurgeForwardRecovery: marker }, { epoch: params.epoch, updatedAt: params.expectedUpdatedAt });
    });
}
export async function markAssignmentState(deps, params) {
    const now = nowMs(deps);
    await deps.store.transaction({ label: "fleet-state.markAssignmentState" }, async (tx) => {
        const user = await tx.users.records.get(params.uid);
        assertRestoreUnfenced(user);
        const assignment = await tx.gateways.assignments.get(params.gatewayId, params.uid);
        if (assignment === null) {
            if (params.expected?.updatedAt !== undefined)
                throw new Error("source assignment changed before roster state update");
            if (!params.createIfMissing)
                return;
            await createMissingAssignment(tx, user, params, now);
            return;
        }
        assertAssignmentStateUpdateMatches(assignment, params);
        assertSharedSurgeForwardStateUpdate(assignment, params);
        const updatesClock = params.updatedByOperationId || params.expected?.updatedAt !== undefined;
        const updatedAt = nextAssignmentStateClock(now, updatesClock ? assignment.updatedAt : undefined);
        await tx.gateways.assignments.patch(params.gatewayId, params.uid, {
            state: params.state,
            ...(updatesClock ? { updatedAt } : {}),
            ...(params.updatedByOperationId ? { updatedByOperationId: params.updatedByOperationId } : {}),
            ...(params.clearSharedSurgeForwardRecovery ? { sharedSurgeForwardRecovery: CLEAR } : {}),
        }, { epoch: assignment.epoch, updatedAt: assignment.updatedAt });
        await writeWorkspaceMigrationMarkerForState(tx, user, params, updatedAt);
    });
}
function assertSharedSurgeForwardStateUpdate(assignment, params) {
    const marker = assignment.sharedSurgeForwardRecovery;
    const clear = params.clearSharedSurgeForwardRecovery;
    if (clear !== undefined) {
        const exact = [params.state === "serving", isDeepStrictEqual(marker, clear),
            params.updatedByOperationId === clear.operationId, params.expected?.updatedByOperationId === clear.operationId,
            params.expected?.state === "quiescing", params.expected?.updatedAt !== undefined,
            params.slug !== undefined, params.epoch !== undefined].every(Boolean);
        if (!exact)
            throw new Error("Shared surge forward recovery completion authority changed");
    }
    else if (marker !== undefined && (params.state === "serving" ||
        params.updatedByOperationId !== undefined && params.updatedByOperationId !== assignment.updatedByOperationId)) {
        throw new Error("Shared surge forward recovery cannot reopen its source or change owner");
    }
}
function nextAssignmentStateClock(now, previous = 0) {
    if (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0) {
        throw new Error("source assignment clock is invalid");
    }
    const updatedAt = Math.max(now, previous + 1);
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0)
        throw new Error("source assignment clock is invalid");
    return updatedAt;
}
async function writeWorkspaceMigrationMarkerForState(tx, user, params, updatedAt) {
    if (params.state === "quiescing") {
        const prior = migrationMarker(user);
        const sameOperation = prior?.operationId !== undefined && prior.operationId === params.updatedByOperationId;
        const continuing = sameOperation ? prior : null;
        const marker = continuing?.state === "moving" ? continuing :
            workspaceMigrationMarker(params.updatedByOperationId, continuing?.startedAt ?? updatedAt);
        await tx.users.records.setFence(params.uid, "migration", marker, user?.fences.migration ?? "absent");
        return;
    }
    if (params.state === "serving")
        await clearWorkspaceMigrationMarker(tx, user, params.uid);
}
async function createMissingAssignment(tx, user, params, now) {
    if (params.state !== "quiescing" || !params.slug || typeof params.epoch !== "number" || !params.updatedByOperationId) {
        throw new Error("unassigned source quiesce requires an exact operation binding");
    }
    const updatedAt = nextAssignmentStateClock(now);
    await tx.gateways.assignments.put({
        uid: params.uid,
        slug: params.slug,
        gatewayId: params.gatewayId,
        source: MIGRATE_USER_OPERATION_KIND,
        state: params.state,
        epoch: params.epoch,
        createdAt: updatedAt,
        updatedAt,
        updatedByOperationId: params.updatedByOperationId,
    });
    await writeWorkspaceMigrationMarkerForState(tx, user, params, updatedAt);
}
function assertAssignmentStateUpdateMatches(assignment, params) {
    const exact = [
        params.slug === undefined || assignment.slug === params.slug,
        params.epoch === undefined || assignment.epoch === params.epoch,
        assignment.gatewayId === params.gatewayId,
        assignment.uid === params.uid,
        !params.createIfMissing || assignment.updatedByOperationId === (params.updatedByOperationId ?? null),
        params.expected === undefined || (assignment.state === params.expected.state &&
            assignment.updatedByOperationId === params.expected.updatedByOperationId &&
            assignmentClockMatches(assignment.updatedAt, params.expected.updatedAt)),
    ].every(Boolean);
    if (!exact)
        throw new Error("source assignment changed before roster state update");
}
function assignmentClockMatches(current, expected) {
    return expected === undefined || Number.isSafeInteger(expected) && expected > 0 && current === expected;
}
